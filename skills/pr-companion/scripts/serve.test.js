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

const CARD = { id: 'c1', status: 'new', reply: 'Draft', proposal: { diff: '-a\n+b' } };
const writeCards = (cards) => fs.writeFileSync(path.join(stateDir, 'companion.json'), JSON.stringify({ cards }));

test('a button press reaches the agent as one EVENT line with only the known fields', async () => {
  lines.length = 0;
  writeCards([CARD]);
  assert.equal((await post({ type: 'reply', cardId: 'c1', card: CARD, reply: 'Fixed.\nThanks', extra: 'dropped' })).ok, true);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^EVENT \{/);
  assert.equal(lines[0].includes('\n'), false);
  const event = JSON.parse(lines[0].slice('EVENT '.length));
  assert.deepEqual(Object.keys(event), ['type', 'cardId', 'at', 'reply']);
  assert.equal(event.reply, 'Fixed.\nThanks');
});

test('a question reaches the agent with its time, for a card or for the whole pull request', async () => {
  lines.length = 0;
  const res = await post({ type: 'ask', cardId: 'c1', question: '  Why not a map?  ', card: 'ignored' });
  const { at } = await res.json();
  assert.equal((await post({ type: 'ask', question: 'What is left?' })).status, 200);
  assert.deepEqual(lines.map((line) => JSON.parse(line.slice('EVENT '.length))).map(({ at: _, ...rest }) => rest), [
    { type: 'ask', cardId: 'c1', question: 'Why not a map?' },
    { type: 'ask', cardId: null, question: 'What is left?' },
  ]);
  assert.equal(JSON.parse(lines[0].slice('EVENT '.length)).at, at);
  for (const body of [{ type: 'ask' }, { type: 'ask', question: '   ' }, { type: 'ask', question: 7 }, { type: 'ask', cardId: 3, question: 'x' }, { type: 'ask', question: 'x'.repeat(4001) }]) {
    assert.equal((await post(body)).status, 400, JSON.stringify(body).slice(0, 60));
  }
});

test('a request for review names reviewers of this pull request, as the page showed it', async () => {
  lines.length = 0;
  const pr = { number: 1, reviewers: [{ login: 'anna', state: 'changes-requested' }, { login: 'bas', state: 'approved' }] };
  fs.writeFileSync(path.join(stateDir, 'companion.json'), JSON.stringify({ pr, cards: [] }));
  assert.equal((await post({ type: 'request-review', pr, reviewers: ['anna'] })).status, 200);
  assert.deepEqual(JSON.parse(lines[0].slice('EVENT '.length)).reviewers, ['anna']);
  assert.equal((await post({ type: 'request-review', pr, reviewers: ['stranger'] })).status, 400);
  assert.equal((await post({ type: 'request-review', pr, reviewers: [] })).status, 400);
  assert.equal((await post({ type: 'request-review', pr: { ...pr, number: 2 }, reviewers: ['anna'] })).status, 409);
  assert.equal(lines.length, 1);
});

test('a press on a card that changed since the page showed it is refused', async () => {
  lines.length = 0;
  writeCards([{ ...CARD, proposal: { diff: '-a\n+c' } }]);
  assert.equal((await post({ type: 'apply', cardId: 'c1', card: CARD })).status, 409);
  assert.equal((await post({ type: 'apply', cardId: 'c1' })).status, 409);
  assert.equal((await post({ type: 'apply', cardId: 'gone', card: CARD })).status, 409);
  fs.writeFileSync(path.join(stateDir, 'companion.json'), '{"cards":[{"id":"c1"');
  assert.equal((await post({ type: 'apply', cardId: 'c1', card: CARD })).status, 409);
  assert.deepEqual(lines, []);
});
