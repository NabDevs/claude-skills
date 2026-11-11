---
name: pr-companion
description: Watch the user's own open pull request while review comes in. Every new review comment gets a verdict, a proposed fix and a draft reply on a local page. Use for "watch my PR", "houd mijn PR in de gaten", or when review comments must be handled as they arrive rather than walked once.
---

# PR companion

A **card** is one judged review comment on the local page: the comment verbatim, the verdict, a proposed fix and a draft reply. The user decides per card. Change the code, the branch or GitHub only for the matching `EVENT` line, or when the user asks for it in the chat.

The companion runs until the pull request (PR) is merged or closed, or until the user stops it in the chat. Then stop the background process of step 2.

## Sources of truth

Load these with the Skill tool before step 2. Their rules apply in full; this skill adds only the watching and the page.

- `external-integrations-basekit:pr-feedback-walk`: "Finding the pull request", "The walk" and "Replying". The page replaces its terminal turn and its "stop and wait": the card is the turn, the button is the go-ahead.
- `external-integrations-basekit:writing-style`: every draft reply and every answer.
- `ai-basekit:commit`: the commit message.

## Steps

### 1. Find the PR

Find it as `pr-feedback-walk` "Finding the pull request" says; a number from the user wins. The PR must be the user's own: for a PR by somebody else, point to `guided-pr-review` and stop. Find where its head branch is checked out: this folder, a git worktree, or nowhere. Watching, judging and replying need no checkout; `apply` does.

Done when you know `<owner>/<repo>`, the number, and the folder that has the head branch checked out, or that there is none.

### 2. Start the companion

Run `node <this skill's directory>/scripts/serve.js <owner>/<repo> <number>` as a background process whose output lines wake you: the `Monitor` tool. It checks the PR, prints `READY <url>`, and then prints the lines of step 3.

- `ERROR … already runs … (pid N)`: an earlier session left its companion. Stop that process and start again.
- Another `ERROR` in place of `READY`: the process has stopped. Tell the user the reason and stop.
- The process stops later without `CLOSED`, for example at a time limit of the harness: start it again in silence. The URL stays the same and the page connects again.

After `READY`, read the PR description and the tickets it names (a key in the title, the branch or the description), each once. They say what this PR must do and what it leaves out. Read who reviewed and who is asked to review. Write the `pr` block to `companion.json` in `~/.local/state/pr-companion/<owner>/<repo>/<number>/` (under `$XDG_STATE_HOME` when that is set), with a `summary` of two or three sentences: what the PR changes and why. A file from an earlier session keeps its cards; give a card that was left in `applying` or `committing` the status that the working tree and `git log` show.

Done when `companion.json` has the `pr` block and the user has the whole URL, with the token after `#`, in one line.

### 3. Handle each line

Handle every line in the order it arrives. A line is done when `companion.json` holds its result; write in the chat only after that. When the work takes more than a moment, put what you do in `activity` ("Judging 13 open comments") and remove it when you are idle.

| Line | What to do |
|---|---|
| `OPEN <threadId> …` / `NEW <threadId> …` | Judge the thread (see below). For a thread that has a card, update that card. |
| `NEW issue <commentId> …` | A comment on the PR conversation. Judge it the same way, with `path` null. Add no card when it holds no review feedback (thanks, an answered question). |
| `NEW review <reviewId> <author> <STATE>` | Somebody submitted a review. Set that reviewer's `state` in `pr.reviewers`. When the review has a summary text with feedback, judge it like a conversation comment. |
| `RESOLVED <threadId>` | When every thread of a card is resolved, set the card to `dismissed` with `statusNote` "Resolved on GitHub". A card with its fix in the working tree (`applied`, `tests-failed`) keeps its status and gets only the note. |
| `HEAD <sha>` | Set `pr.headSha`. For a commit you did not push for a card, check the code again for each card in `new` or `outdated`: when the commit fixed it, say so in `take`; when the diff no longer applies, rewrite it and set `outdated`. |
| `ERROR <message>` | GitHub could not be read; the watcher tries again by itself. Tell the user in one line. |
| `CLOSED <state>` | Tell the user in one line that the PR is merged or closed and that the companion stopped. |

#### Judging a thread

1. Read the whole thread, with the `diffHunk` of its first comment.
2. Do `pr-feedback-walk` walk steps 1 to 4: the comment verbatim, threads on the same problem in one card, the claim checked against the code with `file:line`, then a fix or a pushback. Measure a comment that asks for more than the PR set out to do against the ticket: "outside this ticket" is a pushback when the ticket says so, and the `take` names the ticket.
3. Write the fix as a unified diff in `proposal.diff`. The working tree stays as it is until `apply`. A pushback has no `proposal`.
4. Draft the reply with `writing-style`.
5. Write the card with status `new`. A card with its fix in the working tree (`applied`, `tests-failed`) keeps its status and its `changes`.

Done when the card has `comment`, `hunk` for a thread, `verdict`, a `take` with at least one `file:line`, and `reply`.

#### Events from the page

An `EVENT` line is JSON with `type`, `pr` (the PR it is about, as `owner/repo#number`), `cardId` and `at`. The server passes a button press only for the card exactly as the page showed it, so the press is the user's approval of that card.

Handle a press only when the card has a status from the "From" column. For another status, for example a second `reply` on a `replied` card, write why in `statusNote` and do nothing else. End every event with a write to the card that sets `handled` to the `at` of the event: that write gives the page its buttons back.

| `type` | From | What to do | Status after |
|---|---|---|---|
| `apply` | `new`, `outdated` | Set `applying`. Check that the head branch of the PR is checked out, work in that folder, and check that the files of the fix have no uncommitted changes; if one fails, say so in `statusNote` and set the earlier status again. Apply `proposal.diff`, run the tests and the linter that the `AGENTS.md` or `CLAUDE.md` of this repository names, put `git diff` of the changed files in `changes` and the result in `statusNote`. | `applied` or `tests-failed` |
| `undo` | `applied`, `tests-failed` | Take `changes` out of the working tree with a reverse apply of that diff, and touch nothing else. Remove `changes`. | `new` |
| `commit` | `applied` | Compare `git diff` of the files with `changes`. When they differ, put the new diff in `changes`, say in `statusNote` that the user must look again, and keep `applied`. When they are the same: set `committing`, stage only those files, commit as `pr-feedback-walk` step 6 and `ai-basekit:commit` say, and push. The press is the go-ahead that step 6 asks for. Put the commit SHA in `statusNote`. | `committed` |
| `reply` | `new`, `outdated`, `committed` | Post the `reply` text of the event exactly as it is: in the thread as `pr-feedback-walk` "Replying" says, or with `gh pr comment` for a conversation comment or a review summary. Leave the thread open. Put the URL of the reply in `statusNote`. | `replied` |
| `recheck` | `new`, `outdated`, `committed` | Judge the card again from scratch. | the same |
| `dismiss` | `new`, `outdated`, `committed` | Nothing else. | `dismissed` |
| `request-review` | — | Ask each login in `reviewers` for a new review: `gh api --method POST repos/<owner>/<repo>/pulls/<number>/requested_reviewers -f 'reviewers[]=<login>'`. Set their `state` to `requested`, put the result in `pr.reviewNote` and the `at` in `pr.handled`. | — |
| `watch` | — | The user wants a companion for the PR in `target` too. Do steps 1 to 3 for it, next to this one (see "More than one PR"). | — |
| `ask` | any | A `cardId` of null means the whole PR. Answer the `question` from the code and the thread, in markdown, with `file:line` where it helps. Append `{ at, question, answer }` to the `questions` of the card, or to the top-level `questions`. When the question asks for another fix or another reply, change `proposal` or `reply` too and say so in the answer. A question is no go-ahead for the code, the branch or GitHub. | the same |

Handle lines in silence: the page shows the result. Write in the chat only for `READY`, `ERROR` and `CLOSED`, for one line per new card ("New comment from `<author>` on `<path:line>`, on the page"), and to answer what the user asks there. Ask the user in plain chat text, without a tool that waits for an answer, so that lines keep being handled. When the user says the page waits, read the output of the process: a line that did not wake you may be there.

### More than one PR

One companion watches one PR. For another PR, on a `watch` event or when the user asks, do steps 1 to 3 again with a background process of its own. Each PR has its own state folder and its own page, and the pages link to each other. An `EVENT` names its PR in `pr`; a watcher line belongs to the PR of the process that printed it. Handle each line in the state folder of its own PR.

## companion.json

```json
{
  "pr": {
    "repo": "owner/name", "number": 123, "title": "…", "url": "…", "headSha": "…",
    "branch": "<head branch>", "base": "<base branch>",
    "summary": "<two or three sentences: what the PR changes and why>",
    "body": "<the PR description, verbatim>",
    "tickets": [{ "key": "INT-123", "title": "…", "url": "<https link>" }],
    "reviewers": [{ "login": "…", "state": "changes-requested | commented | approved | requested" }],
    "reviewNote": "<result of the last request for review>",
    "handled": "<at of the last request-review event>"
  },
  "updatedAt": "<ISO time>",
  "activity": "<what you do now; absent when idle>",
  "questions": [{ "at": "<at of the ask event>", "question": "<verbatim>", "answer": "<markdown>" }],
  "cards": [
    {
      "id": "<GraphQL ID of the first thread, the conversation comment or the review>",
      "threadIds": ["<every thread this card answers>"],
      "author": "<login>", "url": "<https link to the comment>",
      "path": "src/File.php", "line": 57,
      "hunk": "<diffHunk of the first comment, verbatim; absent for a conversation comment or a review summary>",
      "comment": "<first comment, verbatim>",
      "replies": [{ "author": "<login>", "body": "<verbatim>" }],
      "verdict": "holds | does-not-hold | unsure",
      "take": "<why, with file:line>",
      "proposal": { "diff": "<unified diff, not applied>" },
      "reply": "<draft reply>",
      "status": "new | outdated | applying | applied | tests-failed | committing | committed | replied | dismissed",
      "statusNote": "<test result, commit SHA, reply URL, or why an event was skipped>",
      "changes": "<git diff of the applied fix>",
      "handled": "<at of the last event handled>",
      "questions": ["<as the top-level questions, about this card>"]
    }
  ]
}
```

`proposal` is absent for a pushback. `reply` is present on every card that is not `dismissed`. `changes` is present only while the fix is in the working tree or in a commit.
