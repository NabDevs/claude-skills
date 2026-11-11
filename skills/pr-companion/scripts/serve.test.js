// Run with: node --test skills/pr-companion/scripts/
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { test, before, after } = require('node:test');
const { createApp } = require('./serve.js');

const TOKEN = 'test-token';
const lines = [];
let server, base, root, stateDir;

before(async () => {
  // The state folder has the layout of the real one: <root>/<owner>/<repo>/<number>.
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-companion-'));
  stateDir = path.join(root, 'owner', 'repo', '1');
  fs.mkdirSync(stateDir, { recursive: true });
  server = createApp({ stateDir, token: TOKEN, pr: 'owner/repo#1', emit: (line) => lines.push(line) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  server.closeAllConnections();
  fs.rmSync(root, { recursive: true });
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
  assert.deepEqual(Object.keys(event), ['type', 'pr', 'cardId', 'at', 'reply']);
  assert.equal(event.pr, 'owner/repo#1');
  assert.equal(event.reply, 'Fixed.\nThanks');
});

test('a question reaches the agent with its time, for a card or for the whole pull request', async () => {
  lines.length = 0;
  const res = await post({ type: 'ask', cardId: 'c1', question: '  Why not a map?  ', card: 'ignored' });
  const { at } = await res.json();
  assert.equal((await post({ type: 'ask', question: 'What is left?' })).status, 200);
  assert.deepEqual(lines.map((line) => JSON.parse(line.slice('EVENT '.length))).map(({ at: _, ...rest }) => rest), [
    { type: 'ask', pr: 'owner/repo#1', cardId: 'c1', question: 'Why not a map?' },
    { type: 'ask', pr: 'owner/repo#1', cardId: null, question: 'What is left?' },
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

test('a pull request to watch is read from its short form or its link', async () => {
  lines.length = 0;
  for (const target of ['owner/other#12', ' https://github.com/owner/other/pull/12 ', 'https://github.com/owner/other/pull/12/']) {
    assert.equal((await post({ type: 'watch', target })).status, 200, target);
  }
  assert.deepEqual(lines.map((line) => JSON.parse(line.slice('EVENT '.length)).target), ['owner/other#12', 'owner/other#12', 'owner/other#12']);
  for (const target of ['', 'owner/other', '#12', 'https://example.com/owner/other/pull/12', 12]) {
    assert.equal((await post({ type: 'watch', target })).status, 400, String(target));
  }
});

test('the page gets the companions that run for other pull requests', async () => {
  const otherDir = path.join(root, 'owner', 'other', '12');
  fs.mkdirSync(otherDir, { recursive: true });
  const other = createApp({ stateDir: otherDir, token: 'other-token', pr: 'owner/other#12', emit: () => {} });
  await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
  const port = other.address().port;
  fs.writeFileSync(path.join(otherDir, 'server.json'), JSON.stringify({ port, token: 'other-token' }));
  fs.writeFileSync(path.join(otherDir, 'companion.json'), JSON.stringify({ pr: { title: 'Other' }, cards: [{ status: 'new' }, { status: 'replied' }, { status: 'applied' }] }));
  // A companion that stopped keeps its server.json; it is left out.
  const stoppedDir = path.join(root, 'owner', 'stopped', '3');
  fs.mkdirSync(stoppedDir, { recursive: true });
  fs.writeFileSync(path.join(stoppedDir, 'server.json'), JSON.stringify({ port: 1, token: 'x' }));

  assert.equal((await get('/prs', {})).status, 403);
  assert.deepEqual(await (await get('/prs')).json(), [{ repo: 'owner/other', number: 12, title: 'Other', todo: 2, url: `http://127.0.0.1:${port}/#other-token` }]);
  other.close();
  other.closeAllConnections();
});

test('a rebase of the stack names pull requests of this stack, as the page showed it', async () => {
  lines.length = 0;
  const pr = { number: 11, stack: [{ number: 11 }, { number: 12 }, { number: 13 }], stackBehind: [12, 13] };
  fs.writeFileSync(path.join(stateDir, 'companion.json'), JSON.stringify({ pr, cards: [] }));
  assert.equal((await post({ type: 'sync-stack', pr, prs: [12, 13] })).status, 200);
  assert.deepEqual(JSON.parse(lines[0].slice('EVENT '.length)).prs, [12, 13]);
  assert.equal((await post({ type: 'sync-stack', pr, prs: [99] })).status, 400);
  assert.equal((await post({ type: 'sync-stack', pr, prs: [] })).status, 400);
  assert.equal((await post({ type: 'sync-stack', pr: { ...pr, stackBehind: [] }, prs: [12] })).status, 409);
  assert.equal(lines.length, 1);
});

test('every event is kept whole in events.jsonl', async () => {
  const eventsFile = path.join(stateDir, 'events.jsonl');
  fs.rmSync(eventsFile, { force: true });
  lines.length = 0;
  const question = 'Why? '.repeat(400).trim();
  const { at } = await (await post({ type: 'ask', cardId: null, question })).json();
  const kept = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(kept, [{ type: 'ask', pr: 'owner/repo#1', cardId: null, at, question }]);
  assert.equal(lines[0], `EVENT ${JSON.stringify(kept[0])}`);
});

test('the whole file comes from the local repository at the head commit', async () => {
  const repoDir = path.join(root, 'checkout');
  fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', repoDir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  git('init', '-q');
  fs.writeFileSync(path.join(repoDir, 'src', 'a.js'), 'one\ntwo\n');
  git('add', '.');
  git('commit', '-q', '-m', 'first');
  const sha = git('rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(repoDir, 'src', 'a.js'), 'changed after the commit\n');

  const withFiles = createApp({ stateDir, token: TOKEN, pr: 'owner/repo#1', repoDir, emit: () => {} });
  await new Promise((resolve) => withFiles.listen(0, '127.0.0.1', resolve));
  const file = (card, headers = { 'X-Companion-Token': TOKEN }) => fetch(`http://127.0.0.1:${withFiles.address().port}/file?card=${card}`, { headers });
  fs.writeFileSync(path.join(stateDir, 'companion.json'), JSON.stringify({ pr: { headSha: sha }, cards: [
    { id: 'c1', path: 'src/a.js', line: 2 }, { id: 'c2', path: 'src/missing.js', line: 1 }, { id: 'c3', path: '../outside', line: 1 }, { id: 'c4', path: null },
  ] }));
  assert.equal((await file('c1', {})).status, 403);
  assert.deepEqual(await (await file('c1')).json(), { path: 'src/a.js', line: 2, sha, text: 'one\ntwo\n' });
  for (const card of ['c2', 'c3', 'c4', 'unknown']) assert.equal((await file(card)).status, 404, card);
  withFiles.close();
  withFiles.closeAllConnections();
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
