#!/usr/bin/env node
// Prints the stack that a pull request is part of, as JSON, or null when it is in no stack.
// A stack is a chain of pull requests in one repository: the base branch of each one is the
// head branch of the one below it.
//
// Usage: node stack.js <owner/repo> <pr-number>
// Output: { "source": "github" | "branches", "prs": [{ number, title, url, branch, base, state }] }
//         with the pull requests from the bottom of the stack to the top,
//         or { "split": { "branch", "prs" } } when more than one pull request builds on one branch.

const { parseTarget, gh } = require('./watch.js');

const entry = (pull) => ({
  number: pull.number, title: pull.title, url: pull.html_url, branch: pull.head.ref, base: pull.base.ref,
  state: pull.merged_at ? 'merged' : pull.state,
});

// The stack as GitHub keeps it: stack is its stack object, pulls are the pull requests in it.
function fromGitHub(stack, pulls) {
  const prs = stack.pull_requests.map(({ number }) => pulls.find((pull) => pull.number === number)).filter(Boolean);
  return prs.length < 2 ? null : { source: 'github', prs: prs.map(entry) };
}

// The stack as the branches show it. Walks down while an open pull request has the base of the
// lowest one as its head, and up while one open pull request builds on the head of the highest.
function fromBranches(number, openPulls) {
  // A pull request from a fork can have any head name, such as main, so it joins no stack.
  const pulls = openPulls.filter((pull) => pull.head.repo?.full_name === pull.base.repo?.full_name);
  const start = pulls.find((pull) => pull.number === number);
  if (!start) return null;
  const chain = [start];
  for (let below; (below = pulls.find((pull) => pull.head.ref === chain[0].base.ref && !chain.includes(pull)));) chain.unshift(below);
  for (;;) {
    const top = chain.at(-1);
    const above = pulls.filter((pull) => pull.base.ref === top.head.ref && !chain.includes(pull));
    if (above.length > 1) return { split: { branch: top.head.ref, prs: above.map((pull) => pull.number) } };
    if (!above.length) break;
    chain.push(above[0]);
  }
  return chain.length < 2 ? null : { source: 'branches', prs: chain.map(entry) };
}

async function findStack({ owner, name, pr }) {
  const api = async (route) => JSON.parse(await gh(['api', `repos/${owner}/${name}/${route}`]));
  const pull = await api(`pulls/${pr}`);
  if (pull.stack?.number) {
    const stack = await api(`stacks/${pull.stack.number}`);
    const pulls = await Promise.all(stack.pull_requests.map(({ number }) => api(`pulls/${number}`)));
    const found = fromGitHub(stack, pulls);
    if (found) return found;
  }
  return fromBranches(pr, await api('pulls?state=open&per_page=100'));
}

module.exports = { fromGitHub, fromBranches };

if (require.main === module) {
  const target = parseTarget(process.argv.slice(2));
  if (!target) {
    console.error('usage: stack.js <owner/repo> <pr-number>');
    process.exit(2);
  }
  findStack(target).then((stack) => console.log(JSON.stringify(stack)), (error) => {
    console.log(`ERROR ${error.message}`);
    process.exit(1);
  });
}
