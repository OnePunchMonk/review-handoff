// Tasks board: dump everything you need done, an agent splits it into separate
// tasks and recommends an agent profile (CLI + model + effort) for each. Approving
// starts each task in its own git worktree and terminal. Each task hands back
// through .review/review.json in its worktree and becomes a tab in the review panel.
"use strict";
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");
const cp = require("child_process");
const crypto = require("crypto");
const skills = require("./skills");
const agents = require("./agents");

let deps; // {claudeBin, openReview, context}
let board = null; // webview panel
let home = null; // main repo root the board belongs to
let organising = null; // {started}
let organiseError = "";
let lastStatus = new Map(); // task id -> status, for "ready" notifications
let poll;

const DEFAULT_PROFILES = [
  { id: "claude-opus-high", label: "Claude Code · Opus · high", cli: "claude", model: "opus", effort: "high", bestFor: "ambiguous or cross-cutting work, debugging, design decisions" },
  { id: "claude-sonnet-medium", label: "Claude Code · Sonnet · medium", cli: "claude", model: "sonnet", effort: "medium", bestFor: "well-scoped features and fixes" },
  { id: "claude-haiku-low", label: "Claude Code · Haiku · low", cli: "claude", model: "haiku", effort: "low", bestFor: "mechanical edits, renames, running scripts" },
  { id: "codex-luna-high", label: "Codex · gpt-5.6-luna · high", cli: "codex", model: "gpt-5.6-luna", effort: "high", bestFor: "precise algorithmic work, an independent second implementation" },
  { id: "codex-luna-low", label: "Codex · gpt-5.6-luna · low", cli: "codex", model: "gpt-5.6-luna", effort: "low", bestFor: "small, fully specified changes" },
];
const profiles = () => {
  const p = vscode.workspace.getConfiguration("reviewHandoff").get("agentProfiles");
  return Array.isArray(p) && p.length ? p : DEFAULT_PROFILES;
};
const profile = (id) => profiles().find((p) => p.id === id) || profiles()[0];

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
};
const mtime = (f) => {
  try {
    return fs.statSync(f).mtimeMs;
  } catch {
    return 0;
  }
};

function run(cmd, args, opts = {}) {
  return new Promise((resolve) =>
    cp.execFile(cmd, args, { maxBuffer: 64 << 20, ...opts }, (err, out, errOut) => resolve({ err, out: String(out || ""), errOut: String(errOut || "") }))
  );
}

// ------------------------------------------------------------------ store

const storePath = () => path.join(home, ".review", "tasks.json");
function load() {
  const s = readJson(storePath()) || {};
  s.dump = s.dump || "";
  s.proposals = s.proposals || [];
  s.tasks = s.tasks || [];
  return s;
}
function save(mutate) {
  const s = load();
  mutate(s);
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  fs.writeFileSync(storePath(), JSON.stringify(s, null, 2) + "\n");
  return s;
}

function excludeReview(root) {
  const common = cp.execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd: root }).toString().trim();
  const file = path.resolve(root, common, "info", "exclude");
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (!/^\.review\/?$/m.test(text)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}.review/\n`);
  }
}

/** What a task is doing, read from its worktree's .review files. */
function status(t) {
  if (!t.dir) return t.waitingOn?.length ? "waiting" : "not started";
  if (!fs.existsSync(t.dir)) return "removed";
  const r = path.join(t.dir, ".review", "review.json");
  const fb = readJson(path.join(t.dir, ".review", "feedback.json"));
  if (fb?.pushed) return "pushed";
  if (!mtime(r)) return "working";
  if (fb?.submittedAt && Date.parse(fb.submittedAt) > mtime(r)) return fb.verdict === "approve" ? "approved" : "changes requested";
  return "ready for review";
}

// --------------------------------------------------------------- organise

function organisePrompt(dump) {
  const roots = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  return `You organise a developer's task dump into separate tasks for coding agents. Repo: ${home}.
Read the repo only as much as you need to scope the tasks (README, top-level layout, files the dump names). Do not edit anything.

Rules:
- One task = one reviewable change (one branch, one PR). Split unrelated work; keep tightly coupled work together. Do not invent work the dump does not ask for.
- If an item is unclear, keep it as a task and set "question" instead of guessing.
- depends_on only when a task really needs another one merged first.
- Pick an agent profile per task from this list, plus one or two alternatives:
${profiles().map((p) => `  - ${p.id}: ${p.bestFor}`).join("\n")}
- mode: "plan" when the approach is open or risky, "act" when it is fully specified.
- skills: names from the user's installed skills below that the agent should use for this task (0-3; only clearly relevant ones).
- prompt: the complete instruction for that agent, under 150 words. Each agent runs in its own checkout of this repo, so use repo-relative paths only, never absolute ones. Include: goal, scope, constraints, where to start, how to verify (targeted tests only), done when. Mention the chosen skills by /name. End with: "When done, hand off for review by following ~/.claude/skills/review-handoff/SKILL.md."

Installed skills:
${skills.catalog(roots)}

Reply with JSON only, no prose:
{"tasks":[{"id":"kebab-case","title":"8 words max","goal":"one sentence","why_separate":"one line","size":"S|M|L","depends_on":[],"profile":"id","alternatives":["id"],"profile_why":"one line","mode":"plan|act","skills":[],"question":"","prompt":"..."}],"notes":""}

Task dump:
<<<
${dump}
>>>`;
}

function parseJson(text) {
  const s = String(text).replace(/^```(?:json)?\s*|\s*```$/g, "");
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  return JSON.parse(s.slice(a, b + 1));
}

/** The organiser can be any profile: Claude, Codex, or your own CLI. Picked on the board. */
function organiserProfile() {
  return profile(load().organiser || vscode.workspace.getConfiguration("reviewHandoff").get("organiserProfile") || "claude-sonnet-medium");
}

async function organise(dump) {
  if (organising || !dump.trim()) return;
  save((s) => (s.dump = dump));
  organising = { started: Date.now() };
  organiseError = "";
  render();
  const r = await agents.run(organiserProfile(), organisePrompt(dump), { cwd: home, access: "read", claudeBin: deps.claudeBin(), timeout: 10 * 60e3 });
  organising = null;
  try {
    if (r.error) throw new Error(r.error);
    const res = parseJson(r.text);
    const ids = new Set(profiles().map((x) => x.id));
    save((s) => {
      s.proposals = (res.tasks || []).map((t, i) => ({
        ...t,
        id: String(t.id || `task-${i + 1}`).toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 40),
        profile: ids.has(t.profile) ? t.profile : profiles()[0].id,
        alternatives: (t.alternatives || []).filter((x) => ids.has(x)),
        mode: t.mode === "act" ? "act" : "plan",
        on: true,
      }));
      s.notes = res.notes || "";
      s.organisedAt = new Date().toISOString();
    });
  } catch (e) {
    organiseError = `Couldn't organise: ${e.message}`;
  }
  render();
}

// ------------------------------------------------------------------ spawn

async function spawn(t) {
  const base = path.basename(home);
  const dir = path.join(path.dirname(home), `${base}.tasks`, t.id);
  const branch = `task/${t.id}`;
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(path.dirname(dir), { recursive: true });
    const exists = !(await run("git", ["rev-parse", "--verify", "--quiet", branch], { cwd: home })).err;
    const r = await run("git", exists ? ["worktree", "add", dir, branch] : ["worktree", "add", "-b", branch, dir, "HEAD"], { cwd: home });
    if (r.err) {
      vscode.window.showErrorMessage(`Couldn't create worktree for "${t.title}": ${(r.errOut || r.err.message).trim().split("\n").pop()}`);
      return null;
    }
  }
  excludeReview(dir);
  fs.mkdirSync(path.join(dir, ".review"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".review", "task.json"), JSON.stringify({ id: t.id, title: t.title, prompt: t.prompt, profile: t.profile, home }, null, 2) + "\n");
  launch(t, dir);
  return { dir, branch };
}

function launch(t, dir) {
  const p = profile(t.profile);
  const name = `Task · ${t.title}`;
  vscode.window.terminals.find((x) => x.name === name)?.dispose();
  const term = vscode.window.createTerminal({ name, cwd: dir, iconPath: new vscode.ThemeIcon("tasklist") });
  // Each task works only in its own worktree, never in the main checkout.
  const prompt = `You are working in a dedicated git worktree at ${dir} (branch task/${t.id}). Make all changes here only.\n\n${String(t.prompt).split(home + "/").join("").split(home).join(".")}`;
  const cmd = agents.interactive(p, prompt, { cwd: dir, plan: t.mode === "plan", claudeBin: deps.claudeBin() });
  term.sendText(cmd);
  term.show(true);
}

async function startSelected() {
  const s = load();
  const chosen = s.proposals.filter((p) => p.on);
  if (!chosen.length) return;
  const chosenIds = new Set(chosen.map((p) => p.id));
  const known = new Set([...s.tasks.map((t) => t.id), ...chosenIds]);
  const ok = await vscode.window.showInformationMessage(
    `Start ${chosen.length} task${chosen.length === 1 ? "" : "s"}?`,
    { modal: true, detail: chosen.map((p) => `• ${p.title}: ${profile(p.profile).label}, ${p.mode}`).join("\n") + `\n\nEach gets its own branch task/<id> and worktree in ../${path.basename(home)}.tasks/, and its own terminal.` },
    "Start"
  );
  if (ok !== "Start") return;
  for (const p of chosen) {
    const waitingOn = (p.depends_on || []).filter((d) => known.has(d));
    const task = { id: p.id, title: p.title, goal: p.goal, prompt: p.prompt, profile: p.profile, mode: p.mode, skills: p.skills || [], size: p.size, waitingOn, createdAt: new Date().toISOString() };
    if (!waitingOn.length) Object.assign(task, await spawn(task), { startedAt: new Date().toISOString() });
    save((st) => {
      st.tasks = [...st.tasks.filter((x) => x.id !== task.id), task];
      st.proposals = st.proposals.filter((x) => x.id !== p.id);
    });
  }
  render();
}

async function startOne(id) {
  const t = load().tasks.find((x) => x.id === id);
  if (!t) return;
  const res = await spawn(t);
  if (res) save((s) => Object.assign(s.tasks.find((x) => x.id === id), res, { startedAt: new Date().toISOString(), waitingOn: [] }));
  render();
}

async function removeTask(id) {
  const t = load().tasks.find((x) => x.id === id);
  if (!t) return;
  if (t.dir && fs.existsSync(t.dir)) {
    const ok = await vscode.window.showWarningMessage(`Remove "${t.title}"?`, { modal: true, detail: `Removes the worktree ${t.dir}. Git refuses if it has uncommitted changes. The branch ${t.branch} is kept.` }, "Remove");
    if (ok !== "Remove") return;
    const r = await run("git", ["worktree", "remove", t.dir], { cwd: home });
    if (r.err) return vscode.window.showErrorMessage(`Not removed: ${(r.errOut || r.err.message).trim().split("\n").pop()}`);
  }
  save((s) => (s.tasks = s.tasks.filter((x) => x.id !== id)));
  render();
}

// ------------------------------------------------------------------ board

/** Chips for the review panel: the main checkout plus every task that has a review. */
function strip(currentRoot) {
  const taskInfo = readJson(path.join(currentRoot, ".review", "task.json"));
  const h = taskInfo?.home || currentRoot;
  const s = readJson(path.join(h, ".review", "tasks.json"));
  if (!s?.tasks?.length) return [];
  const items = fs.existsSync(path.join(h, ".review", "review.json")) ? [{ title: "Main", root: h, status: "" }] : [];
  for (const t of s.tasks) if (t.dir) items.push({ title: t.title, root: t.dir, status: status(t) });
  return items;
}

function rootFor() {
  const folders = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  return folders.find((f) => fs.existsSync(path.join(f, ".git"))) || folders[0];
}

function open(context) {
  home = rootFor();
  if (!home) return vscode.window.showWarningMessage("Open a git repository folder first.");
  if (!board) {
    board = vscode.window.createWebviewPanel("reviewHandoffTasks", "Tasks", { viewColumn: vscode.ViewColumn.Active }, { enableScripts: true, retainContextWhenHidden: true });
    board.iconPath = new vscode.ThemeIcon("tasklist");
    board.onDidDispose(() => {
      board = null;
      clearInterval(poll);
    });
    board.webview.onDidReceiveMessage(onMessage);
    poll = setInterval(tick, 4000);
  } else board.reveal();
  render();
}

function tick() {
  if (!home) return;
  let changed = false;
  for (const t of load().tasks) {
    const st = status(t);
    if (lastStatus.has(t.id) && lastStatus.get(t.id) !== st) {
      changed = true;
      if (st === "ready for review")
        vscode.window.showInformationMessage(`Task ready for review: ${t.title}`, "Open review").then((a) => a && deps.openReview(t.dir, { force: true }));
    }
    lastStatus.set(t.id, st);
  }
  if (changed) render();
}

async function onMessage(m) {
  if (m.type === "dump") save((s) => (s.dump = m.text));
  if (m.type === "organiser") save((s) => (s.organiser = m.id));
  if (m.type === "organise") await organise(m.text);
  if (m.type === "prop") save((s) => Object.assign(s.proposals.find((p) => p.id === m.id) || {}, m.patch));
  if (m.type === "discard") save((s) => (s.proposals = [])) && render();
  if (m.type === "start") await startSelected();
  if (m.type === "startOne") startOne(m.id);
  if (m.type === "review") {
    const t = load().tasks.find((x) => x.id === m.id);
    if (t?.dir) deps.openReview(t.dir, { force: true });
  }
  if (m.type === "terminal") {
    const t = load().tasks.find((x) => x.id === m.id);
    const term = vscode.window.terminals.find((x) => x.name === `Task · ${t?.title}`);
    if (term) term.show();
    else if (t?.dir) launch(t, t.dir);
  }
  if (m.type === "remove") removeTask(m.id);
  if (m.type === "summon") vscode.commands.executeCommand("reviewHandoff.summonSkill");
}

const STATUS_CLASS = { "ready for review": "hot", "changes requested": "warn", working: "busy", pushed: "ok", approved: "ok", waiting: "", "not started": "", removed: "" };

function render() {
  if (!board || !home) return;
  const s = load();
  const nonce = crypto.randomBytes(16).toString("hex");
  const ps = profiles();
  const opt = (p, sel, rec) => `<option value="${esc(p.id)}" ${p.id === sel ? "selected" : ""}>${esc(p.label)}${rec ? " ★" : ""}</option>`;
  const proposal = (p) => {
    const rec = [p.profile, ...(p.alternatives || [])];
    const ordered = [...ps.filter((x) => rec.includes(x.id)), ...ps.filter((x) => !rec.includes(x.id))];
    return `<article class="prop ${p.on ? "" : "off"}" data-id="${esc(p.id)}">
      <header><input type="checkbox" class="on" ${p.on ? "checked" : ""} aria-label="include">
        <input class="title" value="${esc(p.title)}" aria-label="title">
        <span class="chip">${esc(p.size || "M")}</span></header>
      <p class="goal">${esc(p.goal || "")}</p>
      ${p.question ? `<p class="question"><strong>Question:</strong> ${esc(p.question)}</p>` : ""}
      <div class="meta">${p.depends_on?.length ? `<span>after ${p.depends_on.map(esc).join(", ")}</span>` : ""}${p.why_separate ? `<span>${esc(p.why_separate)}</span>` : ""}${(p.skills || []).length ? `<span>skills: ${p.skills.map((x) => `<code>/${esc(x)}</code>`).join(" ")}</span>` : ""}</div>
      <div class="pick">
        <label>Agent <select class="profile">${ordered.map((x) => opt(x, p.profile, x.id === p.profile)).join("")}</select></label>
        <label>Mode <select class="mode"><option value="plan" ${p.mode === "plan" ? "selected" : ""}>Plan first</option><option value="act" ${p.mode === "act" ? "selected" : ""}>Act</option></select></label>
      </div>
      ${p.profile_why ? `<p class="why">★ ${esc(p.profile_why)}</p>` : ""}
      <details><summary>Prompt</summary><textarea class="prompt" rows="7">${esc(p.prompt || "")}</textarea></details>
    </article>`;
  };
  const task = (t) => {
    const st = status(t);
    return `<div class="task" data-id="${esc(t.id)}">
      <div class="t-main"><div class="t-title">${esc(t.title)}</div>
        <div class="t-sub">${esc(profile(t.profile).label)}, ${t.mode === "plan" ? "plan first" : "act"}${t.branch ? ` <code>${esc(t.branch)}</code>` : ""}${t.waitingOn?.length ? `, after ${t.waitingOn.map(esc).join(", ")}` : ""}</div></div>
      <span class="status ${STATUS_CLASS[st] || ""}">${esc(st)}</span>
      <div class="t-act">
        ${!t.dir ? `<button data-a="startOne">Start</button>` : ""}
        ${["ready for review", "changes requested", "approved", "pushed"].includes(st) ? `<button class="primary" data-a="review">Review</button>` : ""}
        ${t.dir && st !== "removed" ? `<button data-a="terminal" title="Show its terminal">Terminal</button>` : ""}
        <button class="ghost" data-a="remove" title="Remove task and worktree">✕</button>
      </div></div>`;
  };
  const on = s.proposals.filter((p) => p.on).length;
  const counts = s.tasks.reduce((a, t) => ((a[status(t)] = (a[status(t)] || 0) + 1), a), {});

  board.webview.html = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  :root { --gap: 12px; }
  body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); background: var(--vscode-editor-background); margin: 0; padding: 20px 24px 48px; line-height: 1.5; }
  main { max-width: 860px; margin: 0 auto; }
  h1 { font-size: 18px; font-weight: 600; margin: 0; letter-spacing: -.01em; }
  .lede { color: var(--vscode-descriptionForeground); margin: 2px 0 4px; }
  .notes { font-size: 12px; color: var(--vscode-descriptionForeground); max-width: 75ch; margin: -2px 0 10px; }
  h2 { font-size: 13px; margin: 28px 0 8px; font-weight: 600; display: flex; gap: 10px; align-items: baseline; }
  h2 .n { font-weight: 400; font-size: 12px; color: var(--vscode-descriptionForeground); }
  button:active:not(:disabled) { transform: translateY(1px); }
  .skel { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }
  .skel i { display: block; height: 10px; border-radius: 4px; background: var(--vscode-panel-border); animation: pulse 1.4s ease-in-out infinite; }
  .skel i:nth-child(1) { width: 60%; height: 12px; } .skel i:nth-child(2) { width: 90%; } .skel i:nth-child(3) { width: 40%; }
  @media (prefers-reduced-motion: reduce) { .skel i, button:active:not(:disabled) { animation: none; transform: none; } }
  textarea, input.title, select { font-family: inherit; font-size: 13px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; }
  textarea { width: 100%; box-sizing: border-box; padding: 8px 10px; resize: vertical; }
  #dump { min-height: 140px; }
  textarea.prompt { font-family: var(--vscode-editor-font-family); font-size: 12px; margin-top: 6px; }
  select { padding: 3px 6px; }
  button { font: inherit; font-size: 12px; border: 0; border-radius: 4px; padding: 5px 12px; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.ghost { background: none; color: var(--vscode-descriptionForeground); padding: 5px 8px; }
  button:disabled { opacity: .5; cursor: default; }
  :focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .bar { display: flex; gap: 8px; align-items: center; margin-top: 8px; flex-wrap: wrap; }
  .hint { font-size: 12px; color: var(--vscode-descriptionForeground); }
  .err { color: var(--vscode-errorForeground); font-size: 12px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: var(--gap); }
  .prop { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 10px 12px; background: var(--vscode-sideBar-background, transparent); display: flex; flex-direction: column; gap: 6px; }
  .prop.off { opacity: .5; }
  .prop header { display: flex; gap: 8px; align-items: center; }
  input.title { flex: 1; min-width: 0; font-weight: 600; background: transparent; border-color: transparent; padding: 2px 4px; }
  input.title:hover, input.title:focus { border-color: var(--vscode-input-border, var(--vscode-panel-border)); }
  .chip { font-size: 11px; border-radius: 999px; padding: 0 7px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .goal { margin: 0; }
  .question { margin: 0; font-size: 12px; border-left: 2px solid var(--vscode-editorWarning-foreground); padding-left: 8px; }
  .meta { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .pick { display: flex; gap: 10px; flex-wrap: wrap; font-size: 12px; } .pick label { display: flex; gap: 6px; align-items: center; }
  .why { margin: 0; font-size: 11px; font-style: italic; color: var(--vscode-descriptionForeground); }
  details summary { cursor: pointer; font-size: 12px; color: var(--vscode-descriptionForeground); }
  code { font-family: var(--vscode-editor-font-family); font-size: 11px; background: var(--vscode-textCodeBlock-background); padding: 0 3px; border-radius: 3px; }
  .task { display: flex; gap: 12px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--vscode-panel-border); }
  .t-main { flex: 1; min-width: 0; } .t-title { font-weight: 600; } .t-sub { font-size: 12px; color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .t-act { display: flex; gap: 6px; }
  .status { font-size: 11px; border-radius: 999px; padding: 1px 8px; white-space: nowrap; border: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); }
  .status.hot { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border-color: transparent; }
  .status.warn { border-color: var(--vscode-editorWarning-foreground); color: var(--vscode-editorWarning-foreground); }
  .status.ok { border-color: var(--vscode-testing-iconPassed, #3fb950); color: var(--vscode-testing-iconPassed, #3fb950); }
  .status.busy::before { content: ""; display: inline-block; width: 6px; height: 6px; border-radius: 50%; background: currentColor; margin-right: 6px; animation: pulse 1.4s ease-in-out infinite; vertical-align: 1px; }
  @keyframes pulse { 50% { opacity: .25; } }
  @media (prefers-reduced-motion: reduce) { .status.busy::before { animation: none; } }
  .empty { color: var(--vscode-descriptionForeground); font-size: 12px; padding: 8px 0; }
  .top { display: flex; align-items: flex-start; gap: 12px; } .top > div { flex: 1; }
</style></head><body><main>
<div class="top"><div><h1>Tasks</h1><p class="lede">${esc(path.basename(home))}. Dump everything, approve the split, and each task runs on its own branch.</p></div>
<button data-summon title="Search all your skills (⌥⌘K)">Summon skill</button></div>

<h2><label for="dump">Dump</label></h2>
<textarea id="dump" placeholder="Paste or type everything you need done, in any order. Bugs, ideas, review comments, half-thoughts.">${esc(s.dump)}</textarea>
<div class="bar"><button class="primary" id="organise" ${organising ? "disabled" : ""}>${organising ? "Organising…" : s.proposals.length ? "Organise again" : "Organise into tasks"}</button>
${organising ? `<span class="hint">${esc(organiserProfile().label)} is reading the repo and splitting the dump. This takes a minute.</span>` : `<label class="hint">with <select id="organiser" aria-label="Agent that organises the dump">${ps.map((x) => `<option value="${esc(x.id)}" ${x.id === organiserProfile().id ? "selected" : ""}>${esc(x.label)}</option>`).join("")}</select>, read-only</label>`}</div>
${organiseError ? `<p class="err" role="alert">${esc(organiseError)} <button id="retry">Try again</button></p>` : ""}
${organising ? `<h2>Proposed <span class="n">splitting the dump</span></h2><div class="grid" aria-busy="true">${"<div class=skel><i></i><i></i><i></i></div>".repeat(3)}</div>` : ""}

${s.proposals.length && !organising ? `<h2>Proposed <span class="n">${s.proposals.length} ${s.proposals.length === 1 ? "task" : "tasks"}</span></h2>
${s.notes ? `<p class="notes">${esc(s.notes)}</p>` : ""}
<div class="grid">${s.proposals.map(proposal).join("")}</div>
<div class="bar"><button class="primary" id="start" ${on ? "" : "disabled"}>${on ? `Start ${on} task${on === 1 ? "" : "s"}` : "Tick tasks to start"}</button><button class="ghost" id="discard">Discard proposals</button>
<span class="hint">★ marks the recommended agent. Each task gets its own worktree and terminal.</span></div>` : ""}

<h2>Running <span class="n">${s.tasks.length ? Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ") : ""}</span></h2>
${s.tasks.length ? s.tasks.map(task).join("") : `<p class="empty">No tasks yet. Dump what you need done above.</p>`}
</main>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const timers = {};
  const later = (k, f) => { clearTimeout(timers[k]); timers[k] = setTimeout(f, 300); };
  const dump = document.getElementById('dump');
  dump.addEventListener('input', () => later('dump', () => vscode.postMessage({ type: 'dump', text: dump.value })));
  document.getElementById('organise').addEventListener('click', () => vscode.postMessage({ type: 'organise', text: dump.value }));
  document.getElementById('organiser')?.addEventListener('change', (e) => vscode.postMessage({ type: 'organiser', id: e.target.value }));
  document.getElementById('retry')?.addEventListener('click', () => vscode.postMessage({ type: 'organise', text: dump.value }));
  document.getElementById('start')?.addEventListener('click', () => vscode.postMessage({ type: 'start' }));
  document.getElementById('discard')?.addEventListener('click', () => vscode.postMessage({ type: 'discard' }));
  document.querySelector('[data-summon]').addEventListener('click', () => vscode.postMessage({ type: 'summon' }));
  document.querySelectorAll('.prop').forEach((el) => {
    const id = el.dataset.id;
    const patch = (p) => vscode.postMessage({ type: 'prop', id, patch: p });
    el.querySelector('.on').addEventListener('change', (e) => { el.classList.toggle('off', !e.target.checked); patch({ on: e.target.checked });
      const n = document.querySelectorAll('.prop .on:checked').length; const b = document.getElementById('start'); b.disabled = !n; b.textContent = n ? 'Start ' + n + ' task' + (n === 1 ? '' : 's') : 'Tick tasks to start'; });
    el.querySelector('.title').addEventListener('input', (e) => later(id + 't', () => patch({ title: e.target.value })));
    el.querySelector('.profile').addEventListener('change', (e) => patch({ profile: e.target.value }));
    el.querySelector('.mode').addEventListener('change', (e) => patch({ mode: e.target.value }));
    el.querySelector('.prompt').addEventListener('input', (e) => later(id + 'p', () => patch({ prompt: e.target.value })));
  });
  document.querySelectorAll('.task [data-a]').forEach((b) => b.addEventListener('click', () => vscode.postMessage({ type: b.dataset.a, id: b.closest('.task').dataset.id })));
</script></body></html>`;
}

function init(d) {
  deps = d;
}

module.exports = { init, open, strip, status, profile, DEFAULT_PROFILES };
