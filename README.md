# claude-skills

Personal Claude Code skills. Each folder in `skills/` is one skill, linked into the Claude config folders:

```bash
ln -sn ~/Documents/projects/claude-skills/skills/<skill> ~/.claude/skills/<skill>
ln -sn ~/Documents/projects/claude-skills/skills/<skill> ~/.claude-personal/skills/<skill>
```

To point an existing link at another folder, use `ln -snf`. Without `-n`, `ln -sf` follows the existing link and creates the new link inside the folder it points to.

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
9. The user can ask the agent a question on the page, about one comment or about the whole pull request, and reads the answer there. (Added on 2026-11-10.)
10. The top of the page says what the pull request is about: a short summary, the ticket and the description. (Added on 2026-11-11.)
11. The page shows what each reviewer did last, and a button asks them for a new review. (Added on 2026-11-11.)
12. More than one pull request can be watched at the same time. The page links to the others and can start one more. (Added on 2026-11-11.)
13. A stack of pull requests is reviewed as a whole. The page shows the stack, and a verdict on one pull request takes the code and the comments of the others into account. (Added on 2026-11-11.)

### Design choices

- `scripts/watch.js` polls GitHub GraphQL every 120 seconds and prints one line only when something changed (`OPEN`, `NEW`, `RESOLVED`, `HEAD`, `CLOSED`, `ERROR`). Between changes it is silent, so a `Monitor` on it costs no tokens.
- At every start the watcher prints `OPEN` for each unresolved thread that has no card in `companion.json` yet, so a session that stopped halfway loses no thread. Comments on the PR conversation and reviews have no resolved state: only new ones are reported, as `NEW issue` and `NEW review`.
- Which comments wake the agent (`isWakeWorthy`): not the user's own comments and replies; not bots on the PR conversation (coverage, CI, releases); yes for bots in review threads (Copilot and other review bots); yes for replies in resolved threads, because they reopen the discussion. Bots are detected by `author.__typename === 'Bot'`, because GraphQL bot logins have no `[bot]` suffix.
- `scripts/serve.js` runs the page and the watcher in one process, so the agent watches one output stream and no watcher is left behind when the server stops. It looks at the pull request before it prints `READY`: wrong arguments, a pull request that does not exist or one by somebody else end the start with one `ERROR` line.
- The server listens on `127.0.0.1` only. Every request except the page itself needs a random token, which the page reads from the URL fragment and sends in the `X-Companion-Token` header. A custom header makes a cross-site request from another page fail on the CORS preflight, and a request under another host name is refused.
- The port and the token are saved in `server.json` (mode 600) and used again at the next start, so the URL of a pull request stays the same and an open tab connects again. A start stops with an `ERROR` when the saved port still answers with that token: two companions on one pull request would each take a part of the new comments.
- `assets/page.html` has no external libraries and its text is English. All comment text goes into the page as text nodes; a link must be an `https` address. It polls `companion.json` every two seconds and rebuilds only the cards that changed, and never the card the user types in.
- The page is built for a tab that stays open. The left side is a list of all comments, with the done ones under "Done"; the right side shows one card in full. An earlier version showed every card open on one long page, and the user found that chaotic in the first real run. The tab title counts the open cards, a new card lights up in the list, and the header says whether the page is connected.
- "Show the whole file" on a card opens the file as it is at the head commit of the pull request, at the line of the comment. The server reads it with `git show` from the folder it was started in, so it needs no checkout of that branch; a commit that is not in the local repository gives a message and the link to GitHub.
- A card shows the code the reviewer pointed at: the last 8 lines of the `diffHunk` that GitHub gives with the comment. Without it the user reads a remark about a line they cannot see. The idea comes from `guided-pr-review`.
- "Fix & reply" does the whole round in one press: apply, test, commit, push, reply. The first real run needed five clicks and three waits for one comment, which the user called clunky. The agent goes on to the commit only when the tests pass and the applied change equals the diff the page showed, so the press still approves exactly what gets committed; else it stops and the card shows why. "Apply only" keeps the step-by-step way. Every button that leaves the computer needs a second click, and then stands alone with "Cancel".
- While Claude works on a card, the card counts the seconds and says whether the press is sent or Claude has started, and the steps show where the fix is.
- A button press shows as busy until the agent changes the card. `page.html` has one table of statuses and one of buttons; a status that the table does not know still gets "Judge again" and "Dismiss".
- A button press is the approval that `pr-feedback-walk` step 6 asks for before a commit, because the page shows the real `git diff` before the commit button appears. To make that true, the page sends the card as it showed it with every press, and the server answers 409 when `companion.json` holds another version of that card. The user then sees the new version and presses again.
- A fix that is applied but not committed is in the working tree. Such a card offers only "Commit & push" and "Undo fix", so no card is closed with its change still there. Before a commit the agent compares the working tree with the diff on the card, and shows the new diff when they differ.
- The agent reads the PR description and the tickets it names once, at the start. They are on the page as context, and they are the measure for a comment that asks for more than the PR set out to do: "outside this ticket" needs the ticket as its reason. `guided-pr-review` gives its reviewer the same scope.
- "Request review again" asks the reviewers who requested changes or only commented, by name on the button, after a second click. It is the last step of the author's round: fixes pushed, replies posted, review asked again. A first request to somebody who did not review yet goes through the chat. For this the watcher reports every new review with its state, also one without text.
- A comment on the PR conversation and a review summary are outside `pr-feedback-walk`, which covers review threads. The agent judges them the same way and replies with `gh pr comment`.
- A question on the page is an `ask` event. The agent answers in `companion.json`, and the page shows "Waiting for Claude…" until an entry with the time of that event is there. A question can make the agent rewrite the proposed fix or the draft reply, because those stay on the page. It is never a go-ahead for the code, the branch or GitHub: those keep their buttons. The idea comes from `guided-pr-review`.
- More than one pull request: each keeps its own process, state folder and page, so nothing about one pull request changed. A page asks its server for the other companions that answer on this computer (`server.json` in the other state folders) and shows them as links with their number of open cards. A field on the page sends a `watch` event, and the agent starts one more companion. A fix can be applied only where the head branch of that pull request is checked out, so a second pull request of the same repository needs a git worktree for its fixes; watching, judging and replying need no checkout.
- A stack: `scripts/stack.js` reads the stack that GitHub keeps for the pull request, and works it out from the branches when GitHub has none (each base branch is the head branch of the one below). The two ways come from `guided-pr-review`. Every open pull request of the stack gets its own companion, and every page shows the whole stack in its header, from the bottom to the top, with a link or a button to start the page that is missing.
- The agent judges a stack as one change that is cut into parts. It reads the diff and the comments of every pull request first. A fix goes into the pull request that adds or changes the line, also when the comment is on a higher one; a fix low in the stack must hold for the pull requests above it; comments in different pull requests about the same code get one fix. Each card says what the other pull requests do with its code.
- After a commit low in the stack, the pull requests above it still stand on the old commit. The page then offers "Rebase the pull requests above", with a second click, because it pushes with force. A fix for a branch that is checked out nowhere is applied in a git worktree in the state folder, so the user's own checkout stays as it is.
- Every event is also written to `events.jsonl`. In the first real run the harness cut a reply of 463 characters short in the line that woke the agent; the file holds the whole event, and `card.js … event <at>` prints it. An earlier version dropped this file because nothing read it.
- `scripts/card.js` writes one change to `companion.json` in one step. It makes the agent faster and keeps the page from reading half a file.
- State per pull request lives in `~/.local/state/pr-companion/<owner>/<repo>/<pr>/` (or under `$XDG_STATE_HOME`): `watch-state.json`, `companion.json`, `server.json`, `events.jsonl`, and a `worktree` folder when a fix needed one.

### Known limits

- The watcher reads the first 100 review threads, the last 50 comments of a thread, and the last 100 conversation comments and 50 reviews.
- A comment that is edited after it was seen is not reported again.
- A new comment that arrives while no companion runs, in a thread that has a card, is reported at the next start. A conversation comment or a review summary whose `NEW` line the agent did not handle is not reported again.

### Test status (2026-11-11)

Unit tests, `node --test skills/pr-companion/scripts/` (27 tests, all pass):

- `watch.test.js`: the argument parsing, `isWakeWorthy`, and the lines for a first start, a later start with and without cards, a new comment, a new review with its state, a resolved thread, a new head and a closed pull request.
- `serve.test.js`: the token, the host name, requests that cannot be read (`//`, a body of `null`), the `EVENT` line of a button press, a question, a request for review, a rebase of the stack and a pull request to watch, the 409 for a card or a pull request that changed, the list of other companions, the event file, and the whole file from a git repository.
- `card.test.js`: a change of a card, of the pull request block and of the top level, and a new card.
- `stack.test.js`: a chain of branches from any of its pull requests, a pull request alone, a fork, a split, and the stack that GitHub keeps.

Read-only against `myparcelnl/sdk#711`:

- A first start prints `READY` and 13 `OPEN` lines. A second start prints the same 13 while no card exists, and 1 when 12 threads have a card.
- A wrong PR number and a pull request by somebody else end with one `ERROR` line that gives the reason, and leave no state folder.
- The URL is the same after a restart; a second companion for the same pull request is refused; a port taken by another program falls back to a free one.
- The server keeps running after `GET //`, and no process is left after it stops.

The page, in headless Chrome with synthetic data for a stack of three pull requests, two of them with a page (59 checks, all pass). The script that drives Chrome is not in this repository:

- Light, dark and a 400 pixel window; no sideways scroll.
- The list and the card next to it; every button of every status; "Fix & reply" with its second click, its counter and its steps; a failed send; a press on a card that changed; the buttons come back after "Judge again".
- The whole file, at the line of the comment.
- Typing in one card while other cards update; a new card; a half-written `companion.json`; a lost and restored connection; a wrong token.
- A question on a card and on the pull request, with the waiting state and the answer.
- The panel about the pull request: summary, ticket, folded description, and the code hunk on a card.
- "Request review again": the reviewers it names, the second click, the busy state and the new states.
- The link to the other pull request, its page, and the field that asks for one more.
- The stack in the header, the button that starts a missing page, the note on a card about the other pull requests, the fix for a lower branch, and the rebase with its second click.

A real run on `NabDevs/claude-skills#1` and `#2`, a stack of two pull requests with comments by a bot (2026-11-11):

- The start gave a card for each of the four review threads and none for the bot's comment on the conversation.
- `stack.js` found the stack from the branches, and from the stack that GitHub keeps after `gh stack sync` made one.
- "Apply fix" on the lower pull request ran in a git worktree, because its branch was checked out nowhere; the tests ran there.
- "Commit & push" made one commit per card and pushed it; the page of the lower pull request then offered the rebase of the upper one.
- "Post reply" posted the text in the thread and left the thread open.
- The verdicts used both pull requests: a fix on the lower one changed what a script of the upper one does, and the card said so.

Not tested yet:

- The page in Safari and Firefox.
- With a real agent: "Fix & reply", "Commit, push & reply", "Undo fix", a fix whose tests fail, "Request review again", the rebase of a stack, a question, and a pull request that is started from the page.
