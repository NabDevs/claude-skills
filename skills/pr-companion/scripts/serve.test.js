// Run with: node --test skills/pr-companion/scripts/
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test, before, after } = require('node:test');
const { createApp } = require('./serve.js');

const TOKEN = 'test-token';
const lines = [];
let server, base, stateDir;

before(async () => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-companion-'));
  server = createApp({ stateDir, token: TOKEN, emit: (line) => lines.push(line) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  server.closeAllConnections();
  fs.rmSync(stateDir, { recursive: true });
});

const get = (route, headers = { 'X-Companion-Token': TOKEN }) => fetch(base + route, { headers });
const post = (body, headers = { 'X-Companion-Token': TOKEN }) => fetch(base + '/event', { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('the page needs no token, the data does', async () => {
  assert.equal((await get('/', {})).status, 200);
  assert.equal((await get('/data', {})).status, 403);
  assert.equal((await get('/data', { 'X-Companion-Token': 'wrong' })).status, 403);
  assert.deepEqual(await (await get('/data')).json(), { cards: [] });
});

test('a request under another host name is refused', async () => {
  const status = await new Promise((resolve) => {
    require('node:http').get(base + '/', { headers: { Host: 'evil.example' } }, (res) => resolve(res.statusCode));
  });
  assert.equal(status, 403);
});

test('a request that cannot be read gets an answer and the server keeps running', async () => {
  const raw = (target) => new Promise((resolve) => {
    const socket = require('node:net').connect(server.address().port, '127.0.0.1', () => socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`));
    socket.once('data', (chunk) => { resolve(Number(String(chunk).split(' ')[1])); socket.destroy(); });
  });
  assert.equal(await raw('//'), 403);
  assert.equal(await raw('/\\\\'), 403);
  for (const body of ['null', '[]', '"text"', 'not json', '{"type":"apply"}', '{"type":"unknown","cardId":"c1"}']) {
    assert.equal((await post(body)).status, 400, body);
  }
  assert.equal((await get('/nothing')).status, 404);
  assert.equal((await get('/data')).status, 200);
});

test('a button press reaches the agent as one EVENT line with only the known fields', async () => {
  lines.length = 0;
  assert.equal((await post({ type: 'reply', cardId: 'c1', reply: 'Fixed.\nThanks', extra: 'dropped' })).ok, true);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^EVENT \{/);
  assert.equal(lines[0].includes('\n'), false);
  const event = JSON.parse(lines[0].slice('EVENT '.length));
  assert.deepEqual(Object.keys(event), ['type', 'cardId', 'at', 'reply']);
  assert.equal(event.reply, 'Fixed.\nThanks');
});
