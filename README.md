# claude-skills

Personal Claude Code skills. Each folder in `skills/` is one skill, linked into the Claude config folders:

```bash
ln -sn ~/Documents/projects/claude-skills/skills/<skill> ~/.claude/skills/<skill>
ln -sn ~/Documents/projects/claude-skills/skills/<skill> ~/.claude-personal/skills/<skill>
```

Use `ln -sn` on a path that does not exist yet. `ln -snf` on an existing link to a folder creates a link inside the target folder instead of replacing the link.

## pr-companion

Watches the user's own open pull request while review comes in, judges each comment, and shows the result on a local page.

### Requirements

These come from the user and define what the skill must do.

1. Watch the user's own open pull request over time and pick up new review comments as they arrive.
2. Judge each comment: does it hold, not hold, or is it unclear. Back the verdict with `file:line` in the code.
3. Propose a fix as a diff, or a reason to push back, and a draft reply.
4. Show this on a dashboard: a **local page** on `127.0.0.1`, not a claude.ai artifact. Code and comments stay on the machine.
5. The user chooses per comment. Every action that changes code, the branch or GitHub has an **optional button**. Nothing happens on its own.
6. Reuse the skills that already exist instead of new rules:
   - `external-integrations-basekit:pr-feedback-walk` for finding the PR, judging a comment, committing a fix and replying.
   - `external-integrations-basekit:writing-style` for every reply.
   - `ai-basekit:commit` for the commit message.
7. Never resolve a review thread. The reviewer resolves it.
8. Only for the user's own pull request. For somebody else's pull request, `guided-pr-review` applies.

### Design choices

- `scripts/watch.js` polls GitHub GraphQL every 120 seconds and prints one line only when something changed (`OPEN`, `NEW`, `RESOLVED`, `HEAD`, `CLOSED`, `ERROR`). Between changes it is silent, so a `Monitor` on it costs no tokens.
- At every start the watcher prints `OPEN` for each unresolved thread that has no card in `companion.json` yet, so a session that stopped halfway loses no thread. Comments on the PR conversation and review summaries have no resolved state: only new ones are reported, as `NEW issue` and `NEW review`. A review summary counts when it has text.
- Which comments wake the agent (`isWakeWorthy`): not the user's own comments and replies; not bots on the PR conversation (coverage, CI, releases); yes for bots in review threads (Copilot and other review bots); yes for replies in resolved threads, because they reopen the discussion. Bots are detected by `author.__typename === 'Bot'`, because GraphQL bot logins have no `[bot]` suffix.
- `scripts/serve.js` runs the page and the watcher in one process, so the agent watches one output stream. It listens on `127.0.0.1` only. Every request except the page itself needs a random token, which the page reads from the URL fragment and sends in the `X-Companion-Token` header. A custom header makes a cross-site request from another page fail on the CORS preflight.
- `assets/page.html` has no external libraries and its text is English. All comment text goes into the page as text nodes; a link must be an `https` address. It polls `companion.json` every two seconds and rebuilds only the cards that changed, and never the card the user types in.
- The page is built for a tab that stays open: the tab title counts the open cards, a new card lights up, done cards collapse under "Done", and one button collapses everything into a list. The header says whether the page is connected.
- Each card shows the next step (apply, commit and push, reply) and makes that button the primary one. The two buttons that leave the computer, "Commit & push" and "Post reply", need a second click, because a reply on GitHub notifies people and cannot be taken back.
- A button press shows as busy until the agent changes the card. `page.html` has one table of statuses and one of buttons; a status that the table does not know still gets "Judge again" and "Dismiss".
- A button press is the approval that `pr-feedback-walk` step 6 asks for before a commit, because the page shows the real `git diff` before the commit button appears. To make that true, the page sends the card as it showed it with every press, and the server answers 409 when `companion.json` holds another version of that card. The user then sees the new version and presses again.
- State per pull request lives in `~/.local/state/pr-companion/<owner>/<repo>/<pr>/` (or under `$XDG_STATE_HOME`): `watch-state.json`, `companion.json`, `server.json`. Button presses are not kept in a file.

### Test status (2026-11-10)

Tested read-only against `myparcelnl/sdk#711`:

- First start lists the 13 open threads; a second run with no changes is silent; the user's own comment is skipped; a changed head prints `HEAD`.
- The server answers 403 without the token, 400 on an unknown event type, and prints a valid `reply` event as an `EVENT` line without extra fields.

Not tested yet:

- The page in a browser.
- The full cycle with real buttons: apply, tests, commit, push, reply.
- A code review of the skill.
