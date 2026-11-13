// Run with: node --test skills/pr-companion/scripts/
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { change } = require('./card.js');

test('change sets and removes fields of a card, the pull request block and the top level', () => {
  const data = { pr: { number: 1 }, cards: [{ id: 'c1', status: 'new', statusNote: 'old' }] };
  change(data, 'c1', { status: 'applied', statusNote: null });
  change(data, 'pr', { headSha: 'abc' });
  change(data, 'top', { activity: 'Judging' });
  assert.deepEqual(data.cards, [{ id: 'c1', status: 'applied' }]);
  assert.deepEqual(data.pr, { number: 1, headSha: 'abc' });
  assert.equal(data.activity, 'Judging');
  assert.match(data.updatedAt, /^\d{4}-\d\d-\d\dT/);
});

test('change adds a card that is not there yet', () => {
  const data = change({}, 'c2', { status: 'new' });
  assert.deepEqual(data.cards, [{ id: 'c2', threadIds: ['c2'], status: 'new' }]);
});
