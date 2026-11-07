# Changelog

## 0.4.1
- Model agnostic: the organiser, tasks and checks run on any profile (Claude Code, Codex, or any CLI through a command template). Pick the organiser on the Tasks board.

## 0.4.0
- One screen instead of five tabs: summary, a map of the change, one line of checks, the current step, finish.
- Concerns attach to the step whose code they are about.
- Senior-review scorecard (reuse, dead code, tests, architecture, simplicity, scale, maintenance).
- Checks and the diagram run headless with a progress line: no terminal, no prompts.
- History: every round saved, with "Compare with now".

## 0.3.0
- Five-tab review panel: Overview, Deep dive, Diagram, Checks, Hand back.
- Change groups: changed blocks grouped into logical changes across files, unexplained code flagged, optional Graphify call graph.
- Independent checks: Codex (MCP), Goldfish (Elephant-Goldfish), Ponytail, targeted tests on Modal CPU.
- Tasks board: dump, organise into tasks with recommended agent profiles, start each in its own worktree.
- Skill summoner (⌥⌘K) with the Claude Code plugin store.
- Activity Bar view. Installs the agent skill for Claude Code and Codex on first run.
- Brevity limits, generated-file detection, size guard.

## 0.2.0
- Inline "why" notes as comment threads, PR review threads, hand-back checklist, Approve & push.
