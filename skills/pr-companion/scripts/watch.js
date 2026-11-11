#!/usr/bin/env node
// Watches one pull request and prints one line per change that needs the agent.
// Silent while nothing changes, so a Monitor on this script costs no tokens between events.
//
// Usage: node watch.js <owner/repo> <pr-number> [--interval <seconds>] [--once]
// Output lines:
//   OPEN    <threadId> <commentId> <author> <path:line>   unresolved thread without a card, at each start
//   NEW     <threadId> <commentId> <author> <path:line>   new comment in a review thread
//   NEW     issue      <commentId> <author> -             new comment on the PR conversation
//   NEW     review     <reviewId>  <author> <STATE>       new review: APPROVED, CHANGES_REQUESTED or COMMENTED
//   RESOLVED <threadId>                                    somebody resolved the thread on GitHub
//   HEAD    <sha>                                          new commit pushed to the PR
//   CLOSED  <MERGED|CLOSED>                                PR is no longer open; the watch ends
//   ERROR   <message>                                      GitHub could not be read; retried next tick.
//                                                          At the start it is the last line: the watch did not start.

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { promisify } = require('node:util');

const USAGE = '<owner/repo> <pr-number> [--interval <seconds>] [--once]';

// The pull request to watch, from the command line arguments, or null when they name none.
function parseTarget([repo = '', prArg, ...rest]) {
  const pr = Number(prArg);
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(pr) || pr < 1) return null;
  const [owner, name] = repo.split('/');
  const at = rest.indexOf('--interval');
  return {
    owner, name, pr,
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

// Runs gh and returns its output. A failure carries the reason gh gave, not the command line.
async function gh(args) {
  try {
    return (await run('gh', args, { encoding: 'utf8' })).stdout;
  } catch (error) {
    const reason = String(error.stderr || error.message).split('\n').find((line) => line.trim());
    throw new Error(reason.replace(/^gh: /, ''));
  }
}

const QUERY = `query($owner:String!, $name:String!, $pr:Int!) {
  repository(owner:$owner, name:$name) {
    pullRequest(number:$pr) {
      state headRefOid author { login }
      comments(last:100) { nodes { id author { login __typename } } }
      reviews(last:50) { nodes { id author { login __typename } state } }
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
// pr:     the pullRequest object of QUERY
// prev:   { head, seen, resolved } of the previous tick, or null at the first start
// carded: ids of the threads that have a card on the page, at the start of a watch; null on later ticks
// Returns the lines to print and the state to save.
function changes(pr, prev, viewer, carded = null) {
  const lines = [];
  const seen = new Set(prev?.seen ?? []);
  const resolved = new Set(prev?.resolved ?? []);
  const isNew = (comment) => !seen.has(comment.id) && Boolean(seen.add(comment.id));
  const login = (comment) => comment.author?.login ?? 'ghost';

  if (prev && pr.headRefOid !== prev.head) lines.push(`HEAD ${pr.headRefOid}`);

  for (const thread of pr.reviewThreads.nodes) {
    const line = (kind, c) => `${kind} ${thread.id} ${c.id} ${login(c)} ${thread.path}:${thread.line ?? '?'}`;
    const unseen = thread.comments.nodes.filter(isNew);
    const wakeWorthy = (comments) => comments.filter((c) => isWakeWorthy(c, thread, viewer));
    if (carded && !thread.isResolved && !carded.has(thread.id)) {
      // Listed again at every start until it has a card, so a session that stopped halfway loses nothing.
      const [first] = wakeWorthy(thread.comments.nodes);
      if (first) lines.push(line('OPEN', first));
    } else if (prev) {
      for (const c of wakeWorthy(unseen)) lines.push(line('NEW', c));
    }
    if (prev?.resolved && thread.isResolved && !resolved.has(thread.id)) lines.push(`RESOLVED ${thread.id}`);
    if (thread.isResolved) resolved.add(thread.id); else resolved.delete(thread.id);
  }
  // Conversation comments and reviews have no resolved state, so only new ones are reported.
  for (const c of pr.comments.nodes) {
    if (isNew(c) && prev && isWakeWorthy(c, null, viewer)) lines.push(`NEW issue ${c.id} ${login(c)} -`);
  }
  for (const r of pr.reviews.nodes) {
    if (isNew(r) && prev && isWakeWorthy(r, null, viewer)) lines.push(`NEW review ${r.id} ${login(r)} ${r.state}`);
  }
  if (pr.state !== 'OPEN') lines.push(`CLOSED ${pr.state}`);

  return { lines, closed: pr.state !== 'OPEN', state: { head: pr.headRefOid, seen: [...seen], resolved: [...resolved] } };
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// One look at GitHub: returns the lines for the agent and saves what was seen.
async function tick(target, viewer, isStart = false) {
  const pr = await fetchPr(target);
  if (isStart && pr.author?.login !== viewer) {
    throw new Error(`PR #${target.pr} is by ${pr.author?.login ?? 'ghost'}, not by ${viewer}: the companion is for your own pull request`);
  }
  const stateDir = stateDirFor(target);
  const stateFile = path.join(stateDir, 'watch-state.json');
  const cards = isStart ? readJson(path.join(stateDir, 'companion.json'))?.cards ?? [] : null;
  const carded = cards && new Set(cards.flatMap((card) => card.threadIds ?? []));
  const result = changes(pr, readJson(stateFile), viewer, carded);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(result.state, null, 2));
  return result;
}

// Watches the pull request until it is merged or closed, and passes each line to emit.
// A failure of the first look rejects: wrong repo, PR number or gh login, or a pull request by
// somebody else. onReady runs after that first look and before its lines, so a caller can start
// what depends on a pull request that exists.
async function watch(target, emit, onReady = () => {}) {
  const viewer = (await gh(['api', 'user', '--jq', '.login'])).trim();
  const first = await tick(target, viewer, true);
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
      if (error.message !== lastError) emit(`ERROR ${error.message}`);
      lastError = error.message;
    }
  }
}

// Runs main for a script started from the command line. A failure is one ERROR line on stdout,
// where the agent reads, and exit code 1; arguments that name no pull request give the usage.
function cli(script, main) {
  const target = parseTarget(process.argv.slice(2));
  if (!target) {
    console.error(`usage: ${script} ${USAGE}`);
    process.exit(2);
  }
  main(target).catch((error) => {
    console.log(`ERROR ${error.message}`);
    process.exit(1);
  });
}

module.exports = { parseTarget, stateDirFor, gh, isWakeWorthy, changes, readJson, watch, cli };

if (require.main === module) cli('watch.js', (target) => watch(target, console.log));
