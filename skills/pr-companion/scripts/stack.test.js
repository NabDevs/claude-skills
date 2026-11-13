// Run with: node --test skills/pr-companion/scripts/
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { fromGitHub, fromBranches } = require('./stack.js');

const repo = { full_name: 'owner/repo' };
const pull = (number, head, base, extra = {}) => ({
  number, title: `PR ${number}`, html_url: `https://github.com/owner/repo/pull/${number}`, state: 'open', merged_at: null,
  head: { ref: head, repo }, base: { ref: base, repo }, ...extra,
});
const numbers = (stack) => stack.prs.map((pr) => pr.number);

test('a chain of branches is a stack, from the bottom to the top, whichever one is asked', () => {
  const pulls = [pull(13, 'c', 'b'), pull(11, 'a', 'main'), pull(14, 'd', 'c'), pull(12, 'b', 'a'), pull(20, 'other', 'main')];
  for (const number of [11, 12, 13, 14]) assert.deepEqual(numbers(fromBranches(number, pulls)), [11, 12, 13, 14]);
  const [bottom] = fromBranches(12, pulls).prs;
  assert.deepEqual(bottom, { number: 11, title: 'PR 11', url: 'https://github.com/owner/repo/pull/11', branch: 'a', base: 'main', state: 'open' });
  assert.equal(fromBranches(12, pulls).source, 'branches');
});

test('a pull request alone in its chain is in no stack', () => {
  const pulls = [pull(11, 'a', 'main'), pull(20, 'other', 'main')];
  assert.equal(fromBranches(11, pulls), null);
  assert.equal(fromBranches(99, pulls), null);
});

test('a pull request from a fork joins no stack', () => {
  const fork = { full_name: 'somebody/repo' };
  const pulls = [pull(11, 'a', 'main'), pull(12, 'main', 'a', { head: { ref: 'main', repo: fork } })];
  assert.equal(fromBranches(11, pulls), null);
});

test('two pull requests on one branch are reported as a split', () => {
  const pulls = [pull(11, 'a', 'main'), pull(12, 'b', 'a'), pull(13, 'c', 'a')];
  assert.deepEqual(fromBranches(11, pulls), { split: { branch: 'a', prs: [12, 13] } });
});

test('the stack of GitHub keeps its order and marks a merged pull request', () => {
  const pulls = [pull(12, 'b', 'a'), pull(11, 'a', 'main', { state: 'closed', merged_at: '2026-11-01T00:00:00Z' })];
  const stack = fromGitHub({ number: 3, pull_requests: [{ number: 11 }, { number: 12 }] }, pulls);
  assert.deepEqual(stack.prs.map((pr) => `${pr.number} ${pr.state}`), ['11 merged', '12 open']);
  assert.equal(fromGitHub({ number: 3, pull_requests: [{ number: 11 }] }, pulls), null);
});
