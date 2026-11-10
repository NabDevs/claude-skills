#!/usr/bin/env node
// Watches one pull request and prints one line per change that needs the agent.
// Silent while nothing changes, so a Monitor on this script costs no tokens between events.
//
// Usage: node watch.js <owner/repo> <pr-number> [--interval <seconds>] [--once]
// Output lines:
//   OPEN    <threadId> <commentId> <author> <path:line>   unresolved thread found at first start
//   NEW     <threadId> <commentId> <author> <path:line>   new comment in a review thread
//   NEW     issue      <commentId> <author> -             new comment on the PR conversation
//   HEAD    <sha>                                          new commit pushed to the PR
//   CLOSED  <MERGED|CLOSED>                                PR is no longer open; the script exits
//   ERROR   <message>                                      GitHub could not be read; retried next tick

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const [repo, prArg, ...rest] = process.argv.slice(2);
if (!repo || !prArg) {
  console.error('usage: watch.js <owner/repo> <pr-number> [--interval <seconds>] [--once]');
  process.exit(2);
}
const pr = Number(prArg);
const once = rest.includes('--once');
const interval = Number(rest[rest.indexOf('--interval') + 1]) || 120;
const [owner, name] = repo.split('/');

const stateDir = path.join(
  process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'),
  'pr-companion', owner, name, String(pr),
);
const stateFile = path.join(stateDir, 'watch-state.json');

const gh = (args) => execFileSync('gh', args, { encoding: 'utf8' });
const viewer = gh(['api', 'user', '--jq', '.login']).trim();

const QUERY = `query($owner:String!, $name:String!, $pr:Int!) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$pr) {
      state headRefOid
      comments(last:100) { nodes { id author { login __typename } body createdAt } }
      reviewThreads(first:100) { nodes {
        id isResolved isOutdated path line
        comments(last:50) { nodes { id author { login __typename } body createdAt } }
      } }
    }
  }
}`;

function fetchPr() {
  const out = gh(['api', 'graphql', '-f', `query=${QUERY}`,
    '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `pr=${pr}`]);
  return JSON.parse(out).data.repository.pullRequest;
}

// Decides whether a new comment must wake the agent.
// comment: { id, author: { login } | null, body, createdAt }
// thread:  { id, isResolved, isOutdated, path, line } or null for a PR conversation comment
// viewer:  login of the PR author running this watcher (the authenticated gh user)
function isWakeWorthy(comment, thread, viewer) {
  // Own comments and own replies: the author already knows what they wrote.
  if (comment.author?.login === viewer) return false;
  // Bots on the conversation post coverage, CI and release notes. Bots in a review
  // thread (Copilot and other review bots) give line feedback that deserves a verdict.
  if (comment.author?.__typename === 'Bot') return thread !== null;
  // Humans, deleted accounts ("ghost") and replies in resolved threads all wake the agent:
  // a reply in a resolved thread reopens the discussion.
  return true;
}

function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return null; }
}

function saveState(state) {
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function tick() {
  const data = fetchPr();
  const prev = loadState();
  const firstRun = prev === null;
  const seen = new Set(prev?.seen ?? []);

  if (!firstRun && data.headRefOid !== prev.head) console.log(`HEAD ${data.headRefOid}`);

  for (const thread of data.reviewThreads.nodes) {
    for (const c of thread.comments.nodes) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      const where = `${thread.path}:${thread.line ?? '?'}`;
      if (firstRun) {
        if (!thread.isResolved && c === thread.comments.nodes[0] && isWakeWorthy(c, thread, viewer)) {
          console.log(`OPEN ${thread.id} ${c.id} ${c.author?.login ?? 'ghost'} ${where}`);
        }
      } else if (isWakeWorthy(c, thread, viewer)) {
        console.log(`NEW ${thread.id} ${c.id} ${c.author?.login ?? 'ghost'} ${where}`);
      }
    }
  }

  for (const c of data.comments.nodes) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    if (!firstRun && isWakeWorthy(c, null, viewer)) {
      console.log(`NEW issue ${c.id} ${c.author?.login ?? 'ghost'} -`);
    }
  }

  saveState({ head: data.headRefOid, seen: [...seen] });

  if (data.state !== 'OPEN') {
    console.log(`CLOSED ${data.state}`);
    process.exit(0);
  }
}

tick(); // a failure on the first run exits: wrong repo, PR number or gh login

// Later failures (network, rate limit) are reported once and retried on the next tick.
let lastError = '';
function safeTick() {
  try {
    tick();
    lastError = '';
  } catch (error) {
    const message = String(error.message).split('\n')[0];
    if (message !== lastError) console.log(`ERROR ${message}`);
    lastError = message;
  }
}
if (!once) setInterval(safeTick, interval * 1000);
