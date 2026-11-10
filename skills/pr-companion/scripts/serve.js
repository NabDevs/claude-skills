#!/usr/bin/env node
// Serves the companion page for one pull request and runs the watcher next to it.
// Every line on stdout is one thing for the agent to handle:
//   READY  <url>                 the page is up; give this URL to the user
//   OPEN | NEW | HEAD | CLOSED   forwarded from watch.js
//   EVENT  <json>                the user pressed a button on the page
//
// Usage: node serve.js <owner/repo> <pr-number> [--interval <seconds>]

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const [repo, prArg, ...rest] = process.argv.slice(2);
if (!repo || !prArg) {
  console.error('usage: serve.js <owner/repo> <pr-number> [--interval <seconds>]');
  process.exit(2);
}
const [owner, name] = repo.split('/');
const stateDir = path.join(
  process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'),
  'pr-companion', owner, name, String(Number(prArg)),
);
fs.mkdirSync(stateDir, { recursive: true });
const dataFile = path.join(stateDir, 'companion.json');
const eventsFile = path.join(stateDir, 'events.jsonl');
const pageFile = path.join(__dirname, '..', 'assets', 'page.html');

const EVENT_TYPES = new Set(['apply', 'commit', 'reply', 'dismiss', 'recheck']);
const token = crypto.randomBytes(16).toString('hex');

function send(res, status, type, body) {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/') {
    return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(pageFile));
  }
  // Every other route needs the token. It travels in a custom header, so a cross-site
  // request from another page in the browser is blocked by the CORS preflight.
  if (req.headers['x-companion-token'] !== token) return send(res, 403, 'text/plain', 'forbidden');

  if (req.method === 'GET' && url.pathname === '/data') {
    const body = fs.existsSync(dataFile) ? fs.readFileSync(dataFile) : '{"cards":[]}';
    return send(res, 200, 'application/json', body);
  }
  if (req.method === 'POST' && url.pathname === '/event') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; if (raw.length > 100_000) req.destroy(); });
    req.on('end', () => {
      let event;
      try { event = JSON.parse(raw); } catch { return send(res, 400, 'text/plain', 'bad json'); }
      if (!EVENT_TYPES.has(event.type) || typeof event.cardId !== 'string') {
        return send(res, 400, 'text/plain', 'bad event');
      }
      const clean = { type: event.type, cardId: event.cardId, at: new Date().toISOString() };
      if (event.type === 'reply') clean.reply = String(event.reply ?? '');
      fs.appendFileSync(eventsFile, JSON.stringify(clean) + '\n');
      console.log(`EVENT ${JSON.stringify(clean)}`);
      send(res, 204, 'text/plain', '');
    });
    return;
  }
  send(res, 404, 'text/plain', 'not found');
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  console.log(`READY http://127.0.0.1:${port}/#${token}`);

  const watcher = spawn(process.execPath, [path.join(__dirname, 'watch.js'), repo, prArg, ...rest], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  readline.createInterface({ input: watcher.stdout }).on('line', (line) => {
    console.log(line);
    if (line.startsWith('CLOSED')) server.close();
  });
  watcher.on('exit', (code) => {
    if (code !== 0) console.log(`WATCHER_EXIT ${code}`);
    server.close();
  });
});
