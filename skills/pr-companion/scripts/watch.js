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
//   CLOSED  <MERGED|CLOSED>                                PR is no longer open; the watch ends
//   ERROR   <message>                                      GitHub could not be read; retried next tick

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const USAGE = '<owner/repo> <pr-number> [--interval <seconds>] [--once]';

// The pull request to watch, from the command line arguments.
function parseTarget([repo = '', prArg, ...rest]) {
  const [owner, name] = repo.split('/');
  const at = rest.indexOf('--interval');
  return {
    owner, name, pr: Number(prArg),
    interval: (at !== -1 && Number(rest[at + 1])) || 120,
    once: rest.includes('--once'),
  };
}

// The folder that holds the state of one pull request: watch-state.json and companion.json.
function stateDirFor({ owner, name, pr }) {
  const root = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(root, 'pr-companion', owner, name, String(pr));
}

const run = promisify(execFile);
const gh = async (args) => (await run('gh', args, { encoding: 'utf8' })).stdout;

const QUERY = `query($owner:String!, $name:String!, $pr:Int!) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$pr) {
      state headRefOid
      comments(last:100) { nodes { id author { login __typename } } }
      reviewThreads(first:100) { nodes {
        id isResolved path line
        comments(last:50) { nodes { id author { login __typename } } }
      } }
    }
  }
}`;

async function fetchPr({ owner, name, pr }) {
  const out = await gh(['api', 'graphql', '-f', `query=${QUERY}`,
    '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `pr=${pr}`]);
  return JSON.parse(out).data.repository.pullRequest;
}

// Decides whether a new comment must wake the agent.
// comment: { id, author: { login, __typename } | null }
// thread:  { id, isResolved, path, line } or null for a PR conversation comment
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

// Compares the pull request with the state of the previous tick.
// pr:   the pullRequest object of QUERY
// prev: { head, seen } of the previous tick, or null at the first start
// Returns the lines to print and the state to save.
function changes(pr, prev, viewer) {
  const lines = [];
  const seen = new Set(prev?.seen ?? []);
  const isNew = (comment) => !seen.has(comment.id) && Boolean(seen.add(comment.id));
  const login = (comment) => comment.author?.login ?? 'ghost';

  if (prev && pr.headRefOid !== prev.head) lines.push(`HEAD ${pr.headRefOid}`);

  for (const thread of pr.reviewThreads.nodes) {
    const where = `${thread.path}:${thread.line ?? '?'}`;
    for (const c of thread.comments.nodes) {
      if (!isNew(c) || !isWakeWorthy(c, thread, viewer)) continue;
      if (prev) lines.push(`NEW ${thread.id} ${c.id} ${login(c)} ${where}`);
      else if (!thread.isResolved && c === thread.comments.nodes[0]) lines.push(`OPEN ${thread.id} ${c.id} ${login(c)} ${where}`);
    }
  }
  for (const c of pr.comments.nodes) {
    if (isNew(c) && prev && isWakeWorthy(c, null, viewer)) lines.push(`NEW issue ${c.id} ${login(c)} -`);
  }
  if (pr.state !== 'OPEN') lines.push(`CLOSED ${pr.state}`);

  return { lines, closed: pr.state !== 'OPEN', state: { head: pr.headRefOid, seen: [...seen] } };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// One look at GitHub: returns the lines for the agent and saves what was seen.
async function tick(target, viewer) {
  const stateFile = path.join(stateDirFor(target), 'watch-state.json');
  const result = changes(await fetchPr(target), readJson(stateFile), viewer);
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(result.state, null, 2));
  return result;
}

// Watches the pull request until it is merged or closed, and passes each line to emit.
// A failure of the first look rejects: wrong repo, PR number or gh login. onReady runs after that
// first look and before its lines, so a caller can start what depends on a pull request that exists.
async function watch(target, emit, onReady = () => {}) {
  const viewer = (await gh(['api', 'user', '--jq', '.login'])).trim();
  const first = await tick(target, viewer);
  await onReady();
  for (const line of first.lines) emit(line);
  if (first.closed || target.once) return;

  // Later failures (network, rate limit) are reported once and retried on the next tick.
  let lastError = '';
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, target.interval * 1000));
    try {
      const { lines, closed } = await tick(target, viewer);
      for (const line of lines) emit(line);
      lastError = '';
      if (closed) return;
    } catch (error) {
      const message = String(error.message).split('\n')[0];
      if (message !== lastError) emit(`ERROR ${message}`);
      lastError = message;
    }
  }
}

module.exports = { USAGE, parseTarget, stateDirFor, isWakeWorthy, changes, readJson, watch };

if (require.main === module) {
  const target = parseTarget(process.argv.slice(2));
  if (!target.name || !target.pr) {
    console.error(`usage: watch.js ${USAGE}`);
    process.exit(2);
  }
  watch(target, console.log).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
