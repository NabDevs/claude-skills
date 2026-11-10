#!/usr/bin/env node
// Serves the companion page for one pull request and watches that pull request, in one process.
// Every line on stdout is one thing for the agent to handle:
//   READY  <url>                                    the page is up; give this URL to the user
//   EVENT  <json>                                   the user pressed a button on the page
//   OPEN | NEW | RESOLVED | HEAD | CLOSED | ERROR   from watch.js
//
// Usage: node serve.js <owner/repo> <pr-number> [--interval <seconds>]

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { stateDirFor, readJson, watch, cli } = require('./watch.js');

const PAGE = path.join(__dirname, '..', 'assets', 'page.html');
const EVENT_TYPES = new Set(['apply', 'commit', 'reply', 'dismiss', 'recheck']);
const LOCAL_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/;

// The server for one pull request. stateDir holds companion.json; emit gets each line for the agent.
function createApp({ stateDir, token, emit }) {
  const dataFile = path.join(stateDir, 'companion.json');
  const eventsFile = path.join(stateDir, 'events.jsonl');

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
    req.on('data', (chunk) => { raw += chunk; if (raw.length > 100_000) req.destroy(); });
    req.on('end', () => {
      let event;
      try { event = JSON.parse(raw); } catch { return send(400, 'bad json'); }
      if (!EVENT_TYPES.has(event?.type) || typeof event.cardId !== 'string') return send(400, 'bad event');
      const clean = { type: event.type, cardId: event.cardId, at: new Date().toISOString() };
      if (event.type === 'reply') clean.reply = String(event.reply ?? '');
      fs.appendFileSync(eventsFile, JSON.stringify(clean) + '\n');
      emit(`EVENT ${JSON.stringify(clean)}`);
      send(204, '');
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
