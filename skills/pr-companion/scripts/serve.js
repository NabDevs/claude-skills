#!/usr/bin/env node
// Serves the companion page for one pull request and watches that pull request, in one process.
// Every line on stdout is one thing for the agent to handle:
//   READY  <url>                                    the page is up; give this URL to the user
//   EVENT  <json>                                   the user pressed a button or asked a question on the page
//   OPEN | NEW | RESOLVED | HEAD | CLOSED | ERROR   from watch.js
//
// Usage: node serve.js <owner/repo> <pr-number> [--interval <seconds>]

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { stateDirFor, readJson, watch, cli } = require('./watch.js');

const PAGE = path.join(__dirname, '..', 'assets', 'page.html');
const BUTTONS = new Set(['apply', 'undo', 'commit', 'reply', 'dismiss', 'recheck']);
const MAX_QUESTION = 4000;
const MAX_BODY = 1_000_000; // a button press carries the card the page showed, with its diffs
const LOCAL_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/;

// The server for one pull request. stateDir holds companion.json; emit gets each line for the agent.
function createApp({ stateDir, token, emit }) {
  const dataFile = path.join(stateDir, 'companion.json');

  return http.createServer((req, res) => {
    const send = (status, body, type = 'text/plain') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(body);
    };
    // Another site can point its own name at 127.0.0.1 (DNS rebinding); its Host header gives it away.
    if (!LOCAL_HOST.test(req.headers.host || '')) return send(403, 'forbidden');
    const route = `${req.method} ${req.url.split('?')[0]}`;
    if (route === 'GET /') return send(200, fs.readFileSync(PAGE), 'text/html; charset=utf-8');
    // Every other route needs the token. It travels in a custom header, so a cross-site
    // request from another page in the browser is blocked by the CORS preflight.
    if (req.headers['x-companion-token'] !== token) return send(403, 'forbidden');

    if (route === 'GET /data') {
      return send(200, fs.existsSync(dataFile) ? fs.readFileSync(dataFile) : '{"cards":[]}', 'application/json');
    }
    if (route !== 'POST /event') return send(404, 'not found');

    let raw = '';
    req.on('data', (chunk) => { raw += chunk; if (raw.length > MAX_BODY) req.destroy(); });
    req.on('end', () => {
      let event;
      try { event = JSON.parse(raw); } catch { return send(400, 'bad json'); }
      // Only the known fields go to the agent. `at` names the event: the agent writes it back with its answer.
      const clean = { type: event?.type, cardId: event?.cardId ?? null, at: new Date().toISOString() };
      const data = readJson(dataFile) ?? {};
      if (clean.type === 'ask') {
        // A question is about one card, or about the whole pull request when it names no card.
        clean.question = typeof event.question === 'string' ? event.question.trim() : '';
        const badCard = clean.cardId !== null && typeof clean.cardId !== 'string';
        if (!clean.question || clean.question.length > MAX_QUESTION || badCard) return send(400, 'bad question');
      } else if (clean.type === 'request-review') {
        // A new review can be asked from the reviewers on the page, and only while the page shows the pull request as it is.
        const known = new Set((data.pr?.reviewers ?? []).map((reviewer) => reviewer.login));
        const logins = Array.isArray(event.reviewers) ? event.reviewers : [];
        if (!logins.length || !logins.every((login) => known.has(login))) return send(400, 'bad reviewers');
        if (JSON.stringify(data.pr) !== JSON.stringify(event.pr)) return send(409, 'pull request changed');
        clean.reviewers = logins;
      } else {
        if (!BUTTONS.has(clean.type) || typeof clean.cardId !== 'string') return send(400, 'bad event');
        // A press approves what the page showed, so it only counts for the card as it is now.
        const current = (data.cards ?? []).find((card) => card.id === clean.cardId);
        if (!current || JSON.stringify(current) !== JSON.stringify(event.card)) return send(409, 'card changed');
        if (clean.type === 'reply') clean.reply = String(event.reply ?? '');
      }
      emit(`EVENT ${JSON.stringify(clean)}`);
      send(200, JSON.stringify({ at: clean.at }), 'application/json');
    });
  });
}

// True when a companion with this token answers on the port.
async function answers(port, token) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/data`, { headers: { 'X-Companion-Token': token }, signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

// Listens on the given port, or on a free one when that port is taken, and resolves the port.
function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', (error) => (port && error.code === 'EADDRINUSE' ? listen(server, 0).then(resolve, reject) : reject(error)));
    server.listen(port, '127.0.0.1', () => resolve(server.address().port));
  });
}

async function main(target) {
  const stateDir = stateDirFor(target); // created by the first look at the pull request
  // The port and the token of the previous session are used again, so the URL stays the same
  // and a tab that is still open finds the page again.
  const serverFile = path.join(stateDir, 'server.json');
  const saved = readJson(serverFile) ?? {};
  const token = saved.token || crypto.randomBytes(16).toString('hex');
  const urlOn = (port) => `http://127.0.0.1:${port}/#${token}`;
  // Two companions on one pull request would each take a part of the new comments.
  if (saved.port && await answers(saved.port, token)) {
    throw new Error(`a companion for this pull request already runs at ${urlOn(saved.port)} (pid ${saved.pid}): stop that process first`);
  }
  const server = createApp({ stateDir, token, emit: console.log });

  // The page starts after the first look at the pull request, so READY means the watch works.
  await watch(target, console.log, async () => {
    const port = await listen(server, saved.port || 0);
    fs.writeFileSync(serverFile, JSON.stringify({ port, token, pid: process.pid }), { mode: 0o600 });
    console.log(`READY ${urlOn(port)}`);
  });
  server.close();
  server.closeAllConnections();
}

module.exports = { createApp };

if (require.main === module) cli('serve.js', main);
