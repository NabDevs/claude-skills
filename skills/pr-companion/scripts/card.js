#!/usr/bin/env node
// Changes one card, or the pull request block, in companion.json. For the agent: one call per
// change, written in one step, so the page never reads half a file.
//
// Usage: node card.js <owner/repo> <pr-number> <card id | pr | top> '<json>' [<field>=<file> ...]
//   <json>          the fields to set; a field with the value null is removed
//   <field>=<file>  sets the field to the text of the file, for a diff or a long text
//   pr              changes the "pr" block; top changes the top level (activity, questions)
//   A card id that is not there yet adds a card.
// Usage: node card.js <owner/repo> <pr-number> event <at>
//   prints the whole event with that time from events.jsonl

const fs = require('node:fs');
const path = require('node:path');
const { parseTarget, stateDirFor, readJson } = require('./watch.js');

// Sets the fields on the target with that id and returns the changed data.
function change(data, id, fields) {
  const cards = (data.cards ??= []);
  const target = id === 'top' ? data : id === 'pr' ? (data.pr ??= {}) : cards.find((card) => card.id === id) ?? cards[cards.push({ id, threadIds: [id] }) - 1];
  for (const [key, value] of Object.entries(fields)) {
    if (value === null) delete target[key];
    else target[key] = value;
  }
  data.updatedAt = new Date().toISOString();
  return data;
}

module.exports = { change };

if (require.main === module) {
  const [repo, number, id, json, ...files] = process.argv.slice(2);
  const target = parseTarget([repo, number]);
  if (!target || !id || !json) {
    console.error("usage: card.js <owner/repo> <pr-number> <card id | pr | top> '<json>' [<field>=<file> ...]\n       card.js <owner/repo> <pr-number> event <at>");
    process.exit(2);
  }
  const stateDir = stateDirFor(target);
  if (id === 'event') {
    const lines = fs.readFileSync(path.join(stateDir, 'events.jsonl'), 'utf8').trim().split('\n');
    console.log(lines.find((line) => JSON.parse(line).at === json) ?? 'null');
  } else {
    const fields = JSON.parse(json);
    for (const pair of files) fields[pair.slice(0, pair.indexOf('='))] = fs.readFileSync(pair.slice(pair.indexOf('=') + 1), 'utf8').trimEnd();
    const file = path.join(stateDir, 'companion.json');
    const data = change(readJson(file) ?? {}, id, fields);
    fs.writeFileSync(file + '.tmp', JSON.stringify(data, null, 2));
    fs.renameSync(file + '.tmp', file);
    console.log(`written: ${id} ${Object.keys(fields).join(', ')}`);
  }
}
