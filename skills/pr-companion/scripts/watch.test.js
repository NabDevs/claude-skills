// Run with: node --test skills/pr-companion/scripts/
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { parseTarget, isWakeWorthy, changes } = require('./watch.js');

const human = (login) => ({ login, __typename: 'User' });
const bot = { login: 'copilot-pull-request-reviewer', __typename: 'Bot' };
const comment = (id, author) => ({ id, author });
const thread = (id, comments, extra = {}) => ({ id, isResolved: false, path: 'src/a.js', line: 7, comments: { nodes: comments }, ...extra });
const pullRequest = (extra = {}) => ({
  state: 'OPEN', headRefOid: 'aaa', author: { login: 'me' },
  comments: { nodes: [] }, reviews: { nodes: [] }, reviewThreads: { nodes: [] }, ...extra,
});

test('parseTarget reads the repository, the number and the options', () => {
  assert.deepEqual(parseTarget(['owner/repo', '12']), { owner: 'owner', name: 'repo', pr: 12, interval: 120, once: false });
  assert.deepEqual(parseTarget(['owner/repo', '12', '--once', '--interval', '5']), { owner: 'owner', name: 'repo', pr: 12, interval: 5, once: true });
  assert.equal(parseTarget(['owner/repo', '12', '5']).interval, 120);
});

test('parseTarget refuses arguments that name no pull request', () => {
  for (const args of [[], ['owner/repo'], ['owner', '12'], ['owner/repo', 'abc'], ['owner/repo', '0'], ['../x/y', '1']]) {
    assert.equal(parseTarget(args), null, JSON.stringify(args));
  }
});

test('isWakeWorthy skips own comments and bots on the conversation', () => {
  assert.equal(isWakeWorthy(comment('1', human('me')), thread('t', []), 'me'), false);
  assert.equal(isWakeWorthy(comment('1', human('anna')), thread('t', []), 'me'), true);
  assert.equal(isWakeWorthy(comment('1', bot), thread('t', []), 'me'), true);
  assert.equal(isWakeWorthy(comment('1', bot), null, 'me'), false);
  assert.equal(isWakeWorthy(comment('1', null), null, 'me'), true);
});

test('the first start lists unresolved threads and stays silent about the rest', () => {
  const pr = pullRequest({
    comments: { nodes: [comment('i1', human('anna'))] },
    reviewThreads: { nodes: [
      thread('t1', [comment('c1', human('anna')), comment('c2', human('me'))]),
      thread('t2', [comment('c3', human('anna'))], { isResolved: true }),
      thread('t3', [comment('c4', bot)], { line: null }),
    ] },
  });
  const { lines, closed, state } = changes(pr, null, 'me', new Set());
  assert.deepEqual(lines, ['OPEN t1 c1 anna src/a.js:7', 'OPEN t3 c4 copilot-pull-request-reviewer src/a.js:?']);
  assert.equal(closed, false);
  assert.deepEqual(state, { head: 'aaa', seen: ['c1', 'c2', 'c3', 'c4', 'i1'], resolved: ['t2'] });
});

test('a later start lists the unresolved threads that still have no card', () => {
  const pr = pullRequest({ reviewThreads: { nodes: [
    thread('t1', [comment('c1', human('anna'))]),
    thread('t2', [comment('c2', human('anna')), comment('c5', human('bas'))]),
    thread('t3', [comment('c3', human('me')), comment('c4', human('anna'))]),
  ] } });
  const prev = { head: 'aaa', seen: ['c1', 'c2', 'c3', 'c4'], resolved: [] };
  assert.deepEqual(changes(pr, prev, 'me', new Set(['t1', 't2'])).lines, ['NEW t2 c5 bas src/a.js:7', 'OPEN t3 c4 anna src/a.js:7']);
  assert.deepEqual(changes(pr, prev, 'me', null).lines, ['NEW t2 c5 bas src/a.js:7']);
});

test('a review and a resolved thread are reported once', () => {
  const review = (id, author, state) => ({ id, author, state });
  const before = pullRequest({ reviewThreads: { nodes: [thread('t1', [comment('c1', human('anna'))])] } });
  const { state } = changes(before, null, 'me', new Set());
  const pr = pullRequest({
    reviews: { nodes: [review('r1', human('anna'), 'CHANGES_REQUESTED'), review('r2', human('bas'), 'APPROVED'), review('r3', bot, 'COMMENTED'), review('r4', human('me'), 'PENDING')] },
    reviewThreads: { nodes: [thread('t1', [comment('c1', human('anna'))], { isResolved: true })] },
  });
  const next = changes(pr, state, 'me');
  assert.deepEqual(next.lines, ['RESOLVED t1', 'NEW review r1 anna CHANGES_REQUESTED', 'NEW review r2 bas APPROVED']);
  assert.deepEqual(changes(pr, next.state, 'me').lines, []);
});

test('a later tick reports new comments, a new head and the end of the pull request', () => {
  const prev = { head: 'aaa', seen: ['c1'] };
  const pr = pullRequest({
    state: 'MERGED', headRefOid: 'bbb',
    comments: { nodes: [comment('i1', human('anna')), comment('i2', bot), comment('i3', human('me'))] },
    reviewThreads: { nodes: [thread('t1', [comment('c1', human('anna')), comment('c2', human('bas')), comment('c3', human('me'))])] },
  });
  assert.deepEqual(changes(pr, prev, 'me').lines, ['HEAD bbb', 'NEW t1 c2 bas src/a.js:7', 'NEW issue i1 anna -', 'CLOSED MERGED']);
  assert.equal(changes(pr, prev, 'me').closed, true);
});

test('a tick with nothing new prints nothing', () => {
  const pr = pullRequest({ reviewThreads: { nodes: [thread('t1', [comment('c1', human('anna'))])] } });
  const { state } = changes(pr, null, 'me');
  assert.deepEqual(changes(pr, state, 'me').lines, []);
});
