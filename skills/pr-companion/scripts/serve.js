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
const { stateDirFor, watch, cli } = require('./watch.js');

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

async function main(target) {
  const stateDir = stateDirFor(target); // created by the first look at the pull request
  const token = crypto.randomBytes(16).toString('hex');
  const server = createApp({ stateDir, token, emit: console.log });

  // The page starts after the first look at the pull request, so READY means the watch works.
  await watch(target, console.log, () => new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      console.log(`READY http://127.0.0.1:${server.address().port}/#${token}`);
      resolve();
    });
  }));
  server.close();
  server.closeAllConnections();
}

module.exports = { createApp };

if (require.main === module) cli('serve.js', main);
