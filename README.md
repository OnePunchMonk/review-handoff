<p align="center"><img src="media/icon.png" width="96" alt=""></p>

<h1 align="center">Review Handoff</h1>

<p align="center">Review what Claude Code and Codex change, before it ships.<br>Grouped diffs with the why inline, independent reviewers, tests on Modal, and a checklist you hand back to the agent.</p>

<p align="center">
  <a href="https://vscode.dev/redirect?url=vscode:extension/onepunchmonk.review-handoff"><img src="https://img.shields.io/badge/Install_in_VS_Code-0078d4?style=for-the-badge&logo=visualstudiocode&logoColor=white" alt="Install in VS Code"></a>
  &nbsp;
  <a href="https://marketplace.visualstudio.com/items?itemName=onepunchmonk.review-handoff"><img src="https://img.shields.io/badge/Marketplace-24292f?style=for-the-badge" alt="VS Code Marketplace"></a>
</p>

## Install (two clicks)

1. Click **Install in VS Code** above. VS Code opens on the extension's page.
2. Click **Install**.

The **Review Handoff** icon appears in the Activity Bar on the left. On first start the extension installs its agent skill for Claude Code (`~/.claude/skills/review-handoff`) and Codex (`~/.codex/skills/review-handoff`), so there is nothing else to set up.

If your workspace is in Restricted Mode, trust the folder: the extension runs `git` and starts agent sessions, so it stays off in untrusted workspaces.

<details><summary>Install without the Marketplace</summary>

Download `review-handoff-<version>.vsix` from [Releases](https://github.com/OnePunchMonk/review-handoff/releases), then:

```bash
code --install-extension review-handoff-<version>.vsix
```
</details>

## Why

Coding agents change a lot in one sweep, and the terminal shows you a wall of edits. You end up approving changes you never really read. Review Handoff makes the agent explain itself and gives you a review loop you control:

- **Grouped changes.** Every changed block is grouped into the logical change it belongs to, across files, in reading order. Code that no explanation covers is flagged with `?`. With [Graphify](https://github.com/Graphify-Labs/graphify) installed, groups follow the real call graph.
- **Short by design.** The summary is capped at 70 words and inline notes at 280 characters. Long explanations live in the Deep dive tab, where you can ask follow-up questions.
- **Not just the agent's word.** Run independent reviewers: Codex (via its MCP server), a fresh-context Goldfish review in the [Elephant-Goldfish](https://github.com/google/elephant-goldfish-model) style that checks whether the write-up is true, and [Ponytail](https://github.com/DietrichGebert/ponytail). Run the targeted tests on Modal CPU. Findings land inline in the diff.
- **You decide.** Tick what to fix, explain, test or revert, add instructions, clarifications and things to remember, then **Send**. Or **Approve & push**: it commits only the reviewed files and pushes the branch, after a confirm, never from main.
- **Data stays out of the way.** Binary files and large generated dumps are set aside, and files the agent changed without mentioning are flagged.

## How it works

```
you ── ask ──▶ agent ── /review-handoff ──▶ .review/review.json ──▶ VS Code panel
 ▲                                                                     │
 └──── paste prompt ◀── .review/feedback.json ◀── Send / Approve & push┘
```

1. When a change is ready, ask your agent for **/review-handoff**. It writes `.review/review.json` (summary, a note per logical change, test targets) and opens VS Code.
2. The panel opens beside the diff with five tabs: **Overview**, **Deep dive**, **Diagram** (Excalidraw), **Checks**, **Hand back**. Click into a change to see its note under the code. Reply there, or comment on any line.
3. **Send** writes `.review/feedback.json` and copies one line to paste into your agent. It does only what you ticked, then hands back a fresh review.

`.review/` is added to `.git/info/exclude` and never committed.

## Tasks: parallel work without the mess

Open **Tasks** from the sidebar. Dump everything you need done. An agent splits it into separate, reviewable tasks, flags anything unclear as a question, and recommends an agent and model for each one (for example Codex `gpt-5.6-luna` at low effort for a small fix, Claude Opus at high effort for a design call). Approve, and each task starts on its own branch, in its own worktree and terminal. Tasks show up as tabs in the review panel when they are ready.

Agent profiles (CLI, model, effort) are a setting: `reviewHandoff.agentProfiles`.

## Skills, without remembering them

Press **⌥⌘K** (Ctrl+Alt+K) to search every skill you have: personal, project and plugin, most used first. Run one in a fresh session or copy its `/command`. The same list includes the Claude Code plugin store, so you can install new skills from it.

## Requirements

- VS Code 1.90 or newer, `git`
- [Claude Code](https://claude.com/claude-code) and/or Codex CLI
- Optional: [`gh`](https://cli.github.com) for PR review threads, [`modal`](https://modal.com) for tests, Graphify, and the EGM or Ponytail plugins (the Checks tab offers to install them)

## Settings

| Setting | Default | |
|---|---|---|
| `reviewHandoff.autoOpen` | `true` | Open the review when `.review/review.json` is written |
| `reviewHandoff.agentProfiles` | built-in five | CLI, model and effort pairs for tasks |
| `reviewHandoff.organiserProfile` | `claude-sonnet-medium` | Splits a task dump |
| `reviewHandoff.jobProfile` | `claude-sonnet-medium` | Runs reviewers and the diagram |
| `reviewHandoff.claudePath`, `modalPath` | found on PATH | |

## Privacy

Everything runs locally through your own `git`, `gh`, `claude`, `codex` and `modal` CLIs. The extension never posts to GitHub: replies you type on PR threads are saved for the agent as drafts.

## Develop

No build step and no dependencies.

```bash
npx @vscode/vsce package     # builds review-handoff-<version>.vsix
code --install-extension review-handoff-*.vsix
```

Releases: push a tag `v*`. CI builds the `.vsix`, attaches it to a GitHub release, and publishes to the Marketplace and Open VSX when the `VSCE_PAT` and `OVSX_PAT` secrets are set.

MIT licensed.
