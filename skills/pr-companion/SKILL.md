---
name: pr-companion
description: Watch the user's own open pull request over time. Picks up each new review comment as it arrives, judges it, and shows the verdict, a proposed fix and a draft reply on a local page with optional buttons. Use for "houd mijn PR in de gaten", "watch my PR", "pr-companion", or when review comments on the user's PR must be followed as they come in rather than walked once.
---

# PR companion

A companion for the author of a pull request (PR). It watches the PR, judges every new review comment, and puts a card on a local page: the comment verbatim, the verdict, a proposed fix as a diff, and a draft reply. The user decides per card. Each button on the page is one decision; nothing reaches the code, the branch or GitHub without one.

The skill is done when the PR is merged or closed, or when the user stops it in the chat.

## Sources of truth

Load these with the Skill tool before step 2. Their rules apply in full; this skill only adds the watching and the page.

- `external-integrations-basekit:pr-feedback-walk`: how to find the PR, how to judge a comment (its walk steps 1 to 4), how to commit a fix (step 6) and how to reply (Replying). The page replaces its terminal turn and its "stop and wait": the card is the turn, the button is the go-ahead.
- `external-integrations-basekit:writing-style`: every draft reply.
- `ai-basekit:commit`: the commit message, as `pr-feedback-walk` step 6 says.

## Steps

### 1. Find the PR

Find it as `pr-feedback-walk` does: repository from `origin`, the open PR for the current branch, a number from the user wins. The PR author must be the authenticated `gh` user; for a PR by somebody else, point to `guided-pr-review` and stop.

Done when you know `<owner>/<repo>`, the number, and that the PR branch is the one checked out here.

### 2. Start the companion

Run `node <this skill's directory>/scripts/serve.js <owner>/<repo> <number>` as a persistent background process whose output lines wake you: the `Monitor` tool, or a background command you can watch. It writes to `~/.local/state/pr-companion/<owner>/<repo>/<number>/` (or under `$XDG_STATE_HOME`).

It prints `READY <url>`. Give the user that URL in one line. The token after `#` is the page's key; the URL works only with it. The URL stays the same when the companion starts again for this PR.

When it prints `ERROR a companion for this pull request already runs … (pid N)`, an earlier session left its process: stop that process and start again.

Done when the user has the URL.

### 3. Handle each line

Handle every line as it arrives. Write the result to `companion.json` first; the page reads it every two seconds.

| Line | What to do |
|---|---|
| `OPEN` / `NEW <threadId> …` | Read the whole thread. Judge it with `pr-feedback-walk` walk steps 1 to 4: comment verbatim, threads on the same problem in one card, the claim checked against the code with `file:line`, then a fix or a pushback. Write the fix as a unified diff that you do not apply. Draft the reply with `writing-style`. Add or update the card with status `new`. |
| `NEW issue <commentId> …` / `NEW review <reviewId> …` | Same, for a comment on the PR conversation or the summary text of a review: `path` is null. Skip it when it is no review feedback (thanks, a question already answered); then add nothing. |
| `RESOLVED <threadId>` | Somebody resolved the thread on GitHub. When every thread of a card is resolved, set the card to `dismissed` with `statusNote` "Resolved on GitHub". |
| `HEAD <sha>` | A new commit. For each open card, check the code again: when the commit fixed it, say so in `take`; when the diff no longer applies, rewrite it and set status `outdated`. |
| `ERROR <message>` | GitHub could not be read. Tell the user in one line. After `READY` the watcher retries by itself. Before `READY` the process has stopped: for a PR by somebody else, point to `guided-pr-review`; else solve the cause and start it again. |
| `CLOSED` | Tell the user in one line that the PR is merged or closed and the companion stopped. |
| `EVENT {"type":"apply"}` | Check first that the PR branch is still checked out and that the files of the fix have no other uncommitted changes; if either fails, explain it in `statusNote` and change nothing. Otherwise apply the card's diff, run the tests and linter this repository's `AGENTS.md` or `CLAUDE.md` names, and put `git diff` of the changed files in `changes` and the result in `statusNote`. Status `applied`, or `tests-failed`. |
| `EVENT {"type":"undo"}` | The fix is in the working tree (`applied` or `tests-failed`). Take the card's `changes` out again with a reverse apply of that diff and touch nothing else. Remove `changes`, say what you did in `statusNote`. Status `new`. |
| `EVENT {"type":"commit"}` | Stage only the files in the card's `changes`, commit as `pr-feedback-walk` step 6 says, and push. The user saw `changes` on the page before pressing the button: that is the approval step 6 asks for. Put the commit SHA in `statusNote`. Status `committed`. |
| `EVENT {"type":"reply","reply":"…"}` | Post the `reply` text from the event exactly as it is, as `pr-feedback-walk` Replying says: in the thread, or as a PR comment for a conversation comment. Leave the thread open. Put the reply URL in `statusNote`. Status `replied`. |
| `EVENT {"type":"recheck"}` | Judge the card again from scratch and update it. Keep its status. |
| `EVENT {"type":"dismiss"}` | Status `dismissed`. |

Handle lines in silence: the page shows the result. Write in the chat only for `READY`, `ERROR` and `CLOSED`, for one line per new card ("New comment from `<author>` on `<path:line>`, on the page"), and when the user asks something there.

Act on the code, the branch or GitHub only for the matching `EVENT`. When the user asks for the same in the chat, that counts too.

## companion.json

```json
{
  "pr": { "repo": "owner/name", "number": 123, "title": "…", "url": "…", "headSha": "…" },
  "updatedAt": "<ISO time>",
  "cards": [
    {
      "id": "<GraphQL ID of the first thread, or of the conversation comment>",
      "threadIds": ["<every thread this card answers>"],
      "author": "<login>", "url": "<link to the comment>",
      "path": "src/File.php", "line": 57,
      "comment": "<first comment, verbatim>",
      "replies": [{ "author": "<login>", "body": "<verbatim>" }],
      "verdict": "holds | does-not-hold | unsure",
      "take": "<why, with file:line>",
      "proposal": { "diff": "<unified diff, not applied>" },
      "reply": "<draft reply>",
      "status": "new | applying | applied | tests-failed | committing | committed | replied | dismissed | outdated",
      "statusNote": "<test result, commit SHA or reply URL>",
      "changes": "<git diff after apply>"
    }
  ]
}
```

`proposal` is absent for a pushback. `reply` is present on every card that is not `dismissed`. Set `applying` or `committing` before long work, so the page shows it.
