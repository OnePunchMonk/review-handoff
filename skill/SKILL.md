---
name: review-handoff
description: Hand finished code changes to the user for review in VS Code, and run the review jobs the panel starts. Writes .review/review.json (short overview, deep dive, a "why" note per hunk, test targets) and opens VS Code, where the Review Handoff extension shows the diff with notes inline, independent reviewers (Codex, Goldfish/EGM, Ponytail), tests on Modal, an Excalidraw diagram, and a hand-back checklist. Use when the user asks to review changes in VS Code, for a review handoff, or says "/review-handoff"; when a prompt names a review-handoff job ("review-codex", "review-goldfish", "review-ponytail", "diagram", "answer"); when told to read .review/feedback.json; or when a task prompt says to hand off for review.
---

# Review Handoff

The user reviews your work in VS Code with the **Review Handoff** extension (`onepunchmonk.review-handoff`, source https://github.com/OnePunchMonk/review-handoff). The panel has five tabs:

| Tab | Shows | Fed by |
|---|---|---|
| Overview | next step, 70-word summary, files, check status, PR | `sections[0]`, `files` |
| Deep dive | long-form sections, every note in reading order, Q&A | `sections[1:]`, `deepDive`, `notes[].detail`, `qa` |
| Diagram | Excalidraw drawing of the change | job `diagram` |
| Checks | Codex, Goldfish, Ponytail findings; tests on Modal CPU | jobs `review-*`, `tests` |
| Hand back | tick what to fix, instructions, memory, Send / Approve & push | everything above |

There is also a **Tasks** board (dump, organise, approve, parallel worktrees) and a **Skills** summoner (⌥⌘K). The VS Code CLI is not on PATH: `C="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"`.

## The brevity contract

The user reported that agents write too much to read. The panel enforces this:
- `sections[0].body` (the summary) is cut at **70 words**, with a warning shown. Aim for 3 lines: what changed, why, the test result.
- Inline notes are cut at **280 characters**. Write 1-2 sentences giving the reason, not the edit.
- Everything longer goes in `deepDive` or `notes[].detail`, which show only in the Deep dive tab.

## 1. Write `<repo>/.review/review.json`

Check the real line numbers first (`git diff -U0 <base>`, `grep -n`). `start`/`end` are 1-based lines in the **current** file.

```json
{
  "title": "short name",
  "base": "HEAD",
  "pr": "owner/repo#123",
  "commit": { "message": "subject\n\nbody" },
  "sections": [
    { "heading": "Summary", "body": "3 lines: what, why, test result" },
    { "heading": "Why this", "body": "..." },
    { "heading": "Why it couldn't be shorter", "body": "..." },
    { "heading": "Not covered", "body": "..." }
  ],
  "deepDive": [{ "heading": "Before and after data flow", "body": "long form is fine here" }],
  "files": [{ "path": "repo/relative.py", "summary": "3-5 words" }],
  "notes": [
    { "id": "kebab-id", "file": "path.py", "start": 51, "end": 70, "title": "few words",
      "body": "1-2 sentences", "detail": "optional long explanation (Deep dive only)", "test": "optional suggested test" }
  ],
  "order": ["note ids in the order a reader should follow"],
  "tests": { "targets": ["tests/test_x.py::test_y", "tests/test_z.py"], "install": "pip install -e . pytest-asyncio",
             "python": "3.11", "ignore": [".git", "**/__pycache__"], "why": "one line: what these cover" },
  "triage": { "path.py:72": { "action": "skip|fix|answer", "why": "one line" } },
  "done": { "<hand-back item key>": "one line: what you did" },
  "qa": [{ "q": "user's question, verbatim", "a": "answer" }]
}
```

- **notes**: one per logical change, placed on its main hunk. The panel groups every changed block around the notes (blocks that call, define or share symbols with a noted block join its group; Graphify's call graph sharpens this when `graphify-out/graph.json` exists) and flags code that no group explains with a ?. Give `order` so the groups read like a story. Skip formatting-only hunks.
- **files**: list every file you changed. Unlisted changed files still show, flagged "not mentioned by the agent". Binary files and large data dumps (benchmark JSON, logs) are set aside automatically; mark others with `"generated": true`.
- **tests**: only targeted tests. The panel runs them on Modal CPU and never runs the full suite, because the user never runs pytest locally. `install` must give the dependencies those tests import. Look at the repo's packaging and CI.
- **pr**: if omitted, the extension finds the branch's PR, including fork PRs, from `upstream`. Use `false` to turn this off. **triage** sets each PR thread's default, keyed by the GitHub `path:line`.
- **done**: after acting on a hand-back, map each finished `todo[].key` to one line. The item then shows as done and unticked.
- Markdown supports lists, tables, fences, bold and code. `` `path/file.py:123` `` becomes a jump link.
- Add `.review/` to `.git/info/exclude` (in the common git dir for worktrees). Never add it to `.gitignore`.

## 2. Open it

```bash
"$C" "<repo>"            # never -r
sleep 3
open "vscode://onepunchmonk.review-handoff/open?root=<abs repo path>"
```

If the window was already open, saving `review.json` refreshes it. A task worktree outside the workspace shows in the Tasks board as "ready for review". Tell the user in one line.

## 3. Jobs the panel starts

Each job runs in a fresh Claude session in a VS Code terminal. The prompt is `Use the review-handoff skill, job "<job>", for the review in <root>.` Read `<root>/.review/review.json` for `base` and the files. Write the output atomically: write a temp file, then rename it.

Findings schema, written to `.review/checks/<reviewer>.json`:
```json
{ "reviewer": "codex", "summary": "1-2 lines", "findings": [
  { "id": "f1", "file": "repo/relative.py", "line": 42, "severity": "must|should|nit",
    "title": "under 10 words", "body": "concrete case: this input leads to this wrong result", "fix": "one line" } ] }
```
Use `must` only for a concrete bug, data loss or security issue. Report a finding only when you have a concrete case. If there are no findings, write `"findings": []`.

- **review-codex**: call the `mcp__codex-cli__codex` tool with `model: "gpt-5.6-luna"`, a read-only sandbox, `cwd` set to root, and a prompt telling it to review `git diff <base>` plus untracked files and return JSON in the schema above. (The `review` tool rejects a custom prompt combined with a base.) Check every finding against the code yourself before writing `checks/codex.json`. Drop any finding you can't confirm, and say so in `summary`.
- **review-goldfish**: a fresh-eyes review in the Elephant-Goldfish style. The reviewers see **only** the diff, the changed files and the write-up (`sections`, `notes`), never the conversation. If the EGM plugin is installed (`claude plugin list` shows `egm@`), spawn its `codebase_details` and `comprehension` agents (subagent types from the egm plugin). Otherwise spawn two general-purpose subagents with those mandates:
  - (a) Does each claim in the write-up match the code? Name the claim and the line that contradicts it.
  - (b) Can a newcomer follow the change? What is unclear, missing or too long?

  Merge their findings into `checks/goldfish.json`. A false claim in the write-up is `must`.
- **review-ponytail**: run the `ponytail-review` skill (from the ponytail plugin) on `git diff <base>` and untracked files, then convert each finding into the schema and write `checks/ponytail.json`. Map severity like this: their "must fix" becomes `must`, "should fix" becomes `should`, and "nice to have" or "cut" becomes `nit`.
- **diagram**: use the `excalidraw-diagram` skill. Draw the change as before and after flow, with real function and message names, and only the parts the diff touches. Write `.review/diagram.excalidraw`, render it to `.review/diagram.png` with the skill's renderer, look at the image, and fix it until it is readable. Write the PNG last, because the panel refreshes when it lands.
- **answer**: you are the main agent session, so you have the context. Read `questions` in `feedback.json`, and for each one not already in `review.json` `qa`, add `{q, a}`, copying `q` exactly. Keep answers short. Link code as `` `path:line` ``. Save `review.json`.
- **tests**: the extension runs this itself (`modal_tests.py`), and it writes `checks/tests.json`. It needs no agent.

## 4. Act on the hand-back

The user presses **Send** and pastes the copied prompt to you. Read `<repo>/.review/feedback.json`:

```json
{ "verdict": "request-changes|approve", "round": 2,
  "todo": [{ "key": "...", "kind": "pr|check|you|change", "from": "@user|Codex|test failed|you|change",
             "status": "...", "file": "...", "line": 0, "text": "...", "url": "...",
             "action": "fix|answer|change|test|revert", "note": "the user's how / what to test" }],
  "context": { "instructions": "...", "clarifications": "...", "remember": "..." },
  "remember": ["one fact per line"], "comments": { "<note id or check key>": ["replies"] },
  "extra": [{ "file": "...", "line": 0, "text": "..." }], "prReplies": [{ "url": "...", "text": "..." }],
  "questions": [{ "q": "..." }], "pushed": { "sha": "...", "remote": "...", "branch": "..." } }
```

- Do **only** the `todo` items, in order. `context.instructions` and `context.clarifications` are the user's own words for this round, and they override earlier assumptions.
- `explain` (on a "no note" block): add a note for it, or remove the change if it isn't needed. `meta:split` ("whole change"): the change is too big to review; propose smaller steps, each one reviewable alone, and wait.
- `fix`/`change`/`revert`: edit the code. `test`: add the test described. `answer`: draft the reply in chat. **Never post PR comments.** `prReplies` are drafts for the user to post.
- `remember`: save each line to memory, following the memory rules.
- Then verify with targeted tests (following the user's test rules), rewrite `review.json` with new line numbers, set `done` for each finished key, clear `triage` entries that are finished, and delete `.review/checks/*.json` that the changes made stale. Don't commit: **Approve & push** is the user's path. If `pushed` is present, don't push again.

## 5. Tasks (parallel work)

A task agent starts in its own worktree (`../<repo>.tasks/<id>`, branch `task/<id>`), and `.review/task.json` holds its title and prompt. Work only in that worktree. When done, do steps 1-2 here with `base` set to the commit the task started from (`git merge-base HEAD <home branch>`), and don't open VS Code yourself, because the Tasks board shows the task as ready.

If the extension is missing (`"$C" --list-extensions | grep review-handoff`), install it: `"$C" --install-extension onepunchmonk.review-handoff`, or download the .vsix from https://github.com/OnePunchMonk/review-handoff/releases and run `"$C" --install-extension review-handoff.vsix`.
