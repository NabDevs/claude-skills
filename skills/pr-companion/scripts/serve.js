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
const DONE = new Set(['replied', 'dismissed']); // the statuses the page counts as done
// A pull request as the user types it: owner/repo#12, or its link on GitHub.
const PULL_REQUEST = /^(?:https:\/\/github\.com\/)?([\w.-]+\/[\w.-]+)(?:#|\/pull\/)(\d+)\/?$/;
const MAX_BODY = 1_000_000; // a button press carries the card the page showed, with its diffs
const LOCAL_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/;

// True when a companion with this token answers on the port.
async function answers(port, token) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/data`, { headers: { 'X-Companion-Token': token }, signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

// The companions that run for other pull requests on this computer, for the links on the page.
async function others(stateDir) {
  const list = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
  const root = path.resolve(stateDir, '..', '..', '..');
  const found = [];
  for (const owner of list(root)) for (const name of list(path.join(root, owner))) for (const number of list(path.join(root, owner, name))) {
    const dir = path.join(root, owner, name, number);
    const server = readJson(path.join(dir, 'server.json'));
    if (dir === path.resolve(stateDir) || !server || !(await answers(server.port, server.token))) continue;
    const data = readJson(path.join(dir, 'companion.json')) ?? {};
    found.push({
      repo: `${owner}/${name}`, number: Number(number), title: data.pr?.title ?? '',
      todo: (data.cards ?? []).filter((card) => !DONE.has(card.status)).length,
      url: `http://127.0.0.1:${server.port}/#${server.token}`,
    });
  }
  return found;
}

// The server for one pull request. stateDir holds companion.json; pr names the pull request
// ("owner/repo#12") in every event; emit gets each line for the agent.
function createApp({ stateDir, token, pr, emit }) {
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
    if (route === 'GET /prs') return void others(stateDir).then((found) => send(200, JSON.stringify(found), 'application/json'));
    if (route !== 'POST /event') return send(404, 'not found');

    let raw = '';
    req.on('data', (chunk) => { raw += chunk; if (raw.length > MAX_BODY) req.destroy(); });
    req.on('end', () => {
      let event;
      try { event = JSON.parse(raw); } catch { return send(400, 'bad json'); }
      // Only the known fields go to the agent. `at` names the event: the agent writes it back with its answer.
      const clean = { type: event?.type, pr, cardId: event?.cardId ?? null, at: new Date().toISOString() };
      const data = readJson(dataFile) ?? {};
      if (clean.type === 'ask') {
        // A question is about one card, or about the whole pull request when it names no card.
        clean.question = typeof event.question === 'string' ? event.question.trim() : '';
        const badCard = clean.cardId !== null && typeof clean.cardId !== 'string';
        if (!clean.question || clean.question.length > MAX_QUESTION || badCard) return send(400, 'bad question');
      } else if (clean.type === 'watch') {
        // The user wants a companion for one more pull request.
        const [, repo, number] = String(event.target ?? '').trim().match(PULL_REQUEST) ?? [];
        if (!repo) return send(400, 'bad pull request');
        clean.target = `${repo}#${number}`;
      } else if (clean.type === 'sync-stack') {
        // The pull requests to rebase are ones of this stack, and the page showed the pull request as it is.
        const known = new Set((data.pr?.stack ?? []).map((entry) => entry.number));
        const numbers = Array.isArray(event.prs) ? event.prs : [];
        if (!numbers.length || !numbers.every((number) => known.has(number))) return send(400, 'bad pull requests');
        if (JSON.stringify(data.pr) !== JSON.stringify(event.pr)) return send(409, 'pull request changed');
        clean.prs = numbers;
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
  const server = createApp({ stateDir, token, pr: `${target.owner}/${target.name}#${target.pr}`, emit: console.log });

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
