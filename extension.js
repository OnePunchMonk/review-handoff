// Review Handoff: review an agent's changes like a GitHub PR, inside VS Code.
//
// Contract: the agent writes <repo>/.review/review.json (schema in README.md).
// Opening a review clears the side bars, shows every changed file in one
// multi-diff editor (~70% width) and a short overview + verdict panel beside it.
// Each note is an inline comment thread on its hunk: collapsed until you click
// into that change, then it opens right under the code. Replies, new comments
// on any line, and the verdict are saved to <repo>/.review/feedback.json.
"use strict";
const vscode = require("vscode");
const path = require("path");
const fs = require("fs");
const cp = require("child_process");
const crypto = require("crypto");
const tasks = require("./tasks");
const skills = require("./skills");
const groups = require("./groups");
const sidebar = require("./sidebar");
const os = require("os");

const SCHEME = "review-base";
const REVIEW_FILE = path.join(".review", "review.json");
const FEEDBACK_FILE = path.join(".review", "feedback.json");

/** @type {{root: string, review: any, mtime: number} | null} */
let current = null;
/** @type {vscode.WebviewPanel | null} */
let panel = null;
/** @type {vscode.CommentController} */
let ctrl;
/** @type {Map<string, vscode.CommentThread>} note id -> thread */
const threads = new Map();
const userThreads = new Set();
/** PR review threads from GitHub, and what we fetched for the panel. */
const prThreads = new Map(); // vscode thread -> {url, path}
let pr = null; // {title, url, threads: [...], discussion: [...], error}
/** Findings from independent reviewers, inline too. vscode thread -> item key */
const checkThreads = new Map();
let extPath = "";

// ------------------------------------------------------------ checks / jobs
//
// Two kinds of work leave the panel:
//  * needs the agent's context (fixes, answers) -> a prompt copied for the
//    user's own Claude/Codex session;
//  * independent (reviews, diagram, tests) -> runs by itself in a VS Code
//    terminal and writes .review/checks/<id>.json or .review/diagram.*,
//    which the panel picks up when it lands.

const REVIEWERS = {
  codex: {
    name: "Codex",
    blurb: "A second model reviews the diff, via the Codex MCP server.",
  },
  goldfish: {
    name: "Goldfish",
    blurb: "Fresh-context reviewers see only the diff and this write-up: do the claims hold, is it clear? (Elephant-Goldfish Model)",
    plugin: { id: "egm", label: "EGM", cmds: ["claude plugin marketplace add google/elephant-goldfish-model", "claude plugin install egm@egm"], without: "Without EGM it runs plain fresh-context subagents." },
  },
  ponytail: {
    name: "Ponytail",
    blurb: "Senior-dev review: bugs, risk, load, missing tests, and what to cut.",
    plugin: { id: "ponytail", label: "Ponytail", cmds: ["claude plugin marketplace add DietrichGebert/ponytail", "claude plugin install ponytail@ponytail"], without: "Needs the Ponytail plugin." },
  },
};
const SEV = { must: "must fix", should: "should fix", nit: "nit" };
const jobs = new Map(); // job id -> {started, terminal}
let plugins = null; // Set of installed Claude Code plugin ids, null until known

function findBin(name, extra) {
  const home = process.env.HOME || "";
  return [`${home}/.local/bin/${name}`, `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, ...(extra || [])].find((p) => fs.existsSync(p)) || name;
}
const cfg = (k) => vscode.workspace.getConfiguration("reviewHandoff").get(k);
const claudeBin = () => cfg("claudePath") || findBin("claude");
const modalBin = () => cfg("modalPath") || findBin("modal");

function detectPlugins() {
  cp.execFile(claudeBin(), ["plugin", "list"], { timeout: 20000 }, (err, out) => {
    plugins = new Set();
    for (const m of String(out || "").matchAll(/❯\s+([\w.-]+)@/g)) plugins.add(m[1]);
    rerender();
  });
}

function checksDir() {
  return path.join(current.root, ".review", "checks");
}

function readCheck(id) {
  const file = path.join(checksDir(), `${id}.json`);
  const data = readJson(file);
  if (!data) return null;
  data.mtime = fs.statSync(file).mtimeMs;
  data.findings = (data.findings || []).map((f, i) => ({ id: f.id || `f${i + 1}`, severity: SEV[f.severity] ? f.severity : "should", ...f }));
  return data;
}

function jobState(id) {
  const j = jobs.get(id);
  const file = id === "diagram" ? path.join(current.root, ".review", "diagram.png") : path.join(checksDir(), `${id}.json`);
  let mtime = 0;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {}
  if (id === "tests" && readJson(file)?.running) return "running";
  if (j && j.root === current.root && mtime < j.started && !j.closed) return "running";
  return mtime ? "done" : "never";
}

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function terminal(name, env) {
  const old = vscode.window.terminals.find((t) => t.name === name);
  if (old) old.dispose();
  const t = vscode.window.createTerminal({ name, cwd: current.root, env });
  t.show(true);
  return t;
}

/** Independent jobs run in their own terminal so the user can watch and approve tool use. */
function runJob(id) {
  if (!current) return;
  const root = current.root;
  let t;
  if (id === "tests") {
    const tests = { ...(readJson(path.join(checksDir(), "tests.json")) ? { targets: readJson(path.join(checksDir(), "tests.json")).targets } : {}), ...(current.review.tests || {}) };
    const off = new Set(loadFeedback().testsOff || []);
    const targets = (tests.targets || []).filter((x) => !off.has(x));
    if (!targets.length) return vscode.window.showWarningMessage("Review Handoff: no test targets ticked.");
    t = terminal("Review · tests (Modal)", { REVIEW_ROOT: root, REVIEW_TESTS: JSON.stringify({ ...tests, targets }) });
    t.sendText(`${shq(modalBin())} run ${shq(path.join(extPath, "modal_tests.py"))}`);
  } else {
    const what = id === "diagram" ? "diagram" : `review-${id}`;
    const label = id === "diagram" ? "diagram" : REVIEWERS[id].name;
    t = terminal(`Review · ${label}`);
    const prof = tasks.profile(cfg("jobProfile") || "claude-sonnet-medium");
    const flags = prof.cli === "claude" ? ` --model ${shq(prof.model)} --effort ${shq(prof.effort)}` : "";
    t.sendText(`${shq(claudeBin())}${flags} ${shq(`Use the review-handoff skill, job "${what}", for the review in ${root}.`)}`);
  }
  jobs.set(id, { root, started: Date.now(), terminal: t });
  rerender();
}

function installPlugin(id) {
  const p = REVIEWERS[id]?.plugin;
  if (!p) return;
  const t = terminal(`Install ${p.label}`);
  t.sendText(p.cmds.map((c) => c.replace(/^claude /, `${shq(claudeBin())} `)).join(" && "));
  jobs.set(`install:${id}`, { root: current.root, started: Date.now(), terminal: t });
}

function addCheckThreads() {
  for (const t of checkThreads.keys()) t.dispose();
  checkThreads.clear();
  const fb = loadFeedback();
  for (const id of Object.keys(REVIEWERS)) {
    const c = readCheck(id);
    if (!c) continue;
    for (const f of c.findings) {
      if (!f.file || !f.line) continue;
      const key = `check:${id}:${f.id}`;
      const body = `**${f.title || ""}**\n\n${f.body || ""}${f.fix ? `\n\n*Fix:* ${f.fix}` : ""}`;
      const replies = (fb.comments[key] || []).map(userComment);
      const vt = ctrl.createCommentThread(fileUri(f.file), new vscode.Range(f.line - 1, 0, f.line - 1, 0), [
        { body: md(body), mode: vscode.CommentMode.Preview, author: { name: REVIEWERS[id].name } },
        ...replies,
      ]);
      vt.label = `${REVIEWERS[id].name} · ${SEV[f.severity]}`;
      vt.canReply = true;
      vt.contextValue = "check";
      vt.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      checkThreads.set(vt, key);
    }
  }
}

let rerenderTimer;
function rerender() {
  clearTimeout(rerenderTimer);
  rerenderTimer = setTimeout(() => {
    if (panel && current) panel.webview.html = renderHtml();
  }, 150);
}

// ---------------------------------------------------------------- git / io

function git(root, args) {
  return new Promise((resolve) => {
    cp.execFile("git", args, { cwd: root, maxBuffer: 64 << 20 }, (err, stdout) => resolve(err ? null : stdout));
  });
}

function baseUri(root, ref, rel) {
  return vscode.Uri.from({ scheme: SCHEME, path: "/" + rel, query: new URLSearchParams({ root, ref, rel }).toString() });
}

const baseProvider = {
  async provideTextDocumentContent(uri) {
    const q = new URLSearchParams(uri.query);
    return (await git(q.get("root"), ["show", `${q.get("ref")}:${q.get("rel")}`])) ?? "";
  },
};

// ------------------------------------------------------------- PR comments

const GH = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "gh"].find((g) => g === "gh" || fs.existsSync(g));

function gh(root, args) {
  return new Promise((resolve) => {
    cp.execFile(GH, args, { cwd: root, maxBuffer: 64 << 20 }, (err, stdout, stderr) =>
      resolve(err ? { error: (stderr || err.message).trim() } : { out: stdout })
    );
  });
}

/** review.pr may be "owner/repo#123", {repo, number}, or absent (ask gh for this branch's PR). */
async function resolvePr(root, spec) {
  if (spec === false) return null;
  if (typeof spec === "string") {
    const m = spec.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
    if (m) return { owner: m[1], name: m[2], number: +m[3] };
  }
  if (spec && spec.repo && spec.number) {
    const [owner, name] = spec.repo.split("/");
    return { owner, name, number: +spec.number };
  }
  const parse = (url) => {
    const m = url && url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
    return m ? { owner: m[1], name: m[2], number: +m[3] } : null;
  };
  const r = await gh(root, ["pr", "view", "--json", "url"]);
  if (r.out) return parse(JSON.parse(r.out).url);
  // Fork workflow: the PR lives on the `upstream` remote, headed by this branch.
  const branch = ((await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])) || "").trim();
  const up = ((await git(root, ["remote", "get-url", "upstream"])) || "").trim().match(/github\.com[:/]([^/]+)\/([^/.]+)/);
  if (!branch || !up) return null;
  const l = await gh(root, ["pr", "list", "-R", `${up[1]}/${up[2]}`, "--head", branch, "--state", "all", "--json", "url", "--limit", "1"]);
  return l.out ? parse((JSON.parse(l.out)[0] || {}).url) : null;
}

const PR_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
  title url
  reviewThreads(first:100){nodes{isResolved isOutdated path line originalLine
    comments(first:30){nodes{author{login} body url createdAt diffHunk}}}}
  reviews(first:50){nodes{author{login} state body url submittedAt}}
  comments(first:50){nodes{author{login} body url createdAt}}}}}`;

async function fetchPr(root, spec) {
  const id = await resolvePr(root, spec);
  if (!id) return null;
  const r = await gh(root, ["api", "graphql", "-f", `query=${PR_QUERY}`, "-f", `owner=${id.owner}`, "-f", `name=${id.name}`, "-F", `number=${id.number}`]);
  if (r.error) return { error: `gh: ${r.error.split("\n")[0]}`, url: `https://github.com/${id.owner}/${id.name}/pull/${id.number}` };
  const p = JSON.parse(r.out).data.repository.pullRequest;
  const discussion = [
    ...p.reviews.nodes.filter((x) => x.body.trim()).map((x) => ({ who: x.author?.login, when: x.submittedAt, body: x.body, url: x.url, kind: x.state.toLowerCase().replace("_", " ") })),
    ...p.comments.nodes.map((x) => ({ who: x.author?.login, when: x.createdAt, body: x.body, url: x.url, kind: "comment" })),
  ].sort((a, b) => a.when.localeCompare(b.when));
  return { title: p.title, url: p.url, number: id.number, threads: p.reviewThreads.nodes, discussion };
}

/** Bot comments are mostly HTML scaffolding; keep the prose. */
function cleanBody(body, url, max = 1500) {
  let s = String(body || "").replace(/<!--[\s\S]*?-->/g, "");
  for (let k = 0; k < 6 && /<details>/i.test(s); k++) s = s.replace(/<details>(?:(?!<details>)[\s\S])*?<\/details>/gi, "");
  s = s.replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, "$1").replace(/<\/?[a-z][^>]*>/gi, "").replace(/\n{3,}/g, "\n\n").trim();
  if (s.length > max) s = s.slice(0, max).replace(/\s+\S*$/, "") + ` … [full comment](${url})`;
  return s || `[open on GitHub](${url})`;
}

/** GitHub lines are PR-head lines; re-anchor on the hunk's last line if the local file moved. */
function anchorLine(rel, t) {
  const want = t.line || t.originalLine || 1;
  const hunk = (t.comments.nodes[0]?.diffHunk || "").split("\n");
  const target = (hunk[hunk.length - 1] || "").slice(1).trim();
  let lines;
  try {
    lines = fs.readFileSync(path.join(current.root, rel), "utf8").split("\n");
  } catch {
    return { line: want, moved: false };
  }
  if (target.length > 3) {
    let best = -1;
    lines.forEach((l, i) => {
      if (l.trim() === target && (best < 0 || Math.abs(i + 1 - want) < Math.abs(best + 1 - want))) best = i;
    });
    if (best >= 0) return { line: best + 1, moved: false };
  }
  return { line: Math.min(want, lines.length), moved: true };
}

function addPrThreads() {
  for (const t of prThreads.keys()) t.dispose();
  prThreads.clear();
  if (!pr || !pr.threads) return;
  for (const t of pr.threads) {
    if (!t.path || !t.comments.nodes.length) continue;
    const { line, moved } = anchorLine(t.path, t);
    const comments = t.comments.nodes.map((c) => ({
      body: md(`${cleanBody(c.body, c.url)}\n\n[on GitHub](${c.url})`),
      mode: vscode.CommentMode.Preview,
      author: { name: `@${c.author?.login || "ghost"}` },
      timestamp: new Date(c.createdAt),
    }));
    const vt = ctrl.createCommentThread(fileUri(t.path), new vscode.Range(line - 1, 0, line - 1, 0), comments);
    const status = t.isResolved ? "resolved" : t.isOutdated ? "outdated" : "open";
    vt.label = `PR #${pr.number} · ${status}${moved ? " · code changed locally" : ""}`;
    vt.canReply = true; // replies are saved for the agent, never posted
    vt.contextValue = "pr";
    vt.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    if (vscode.CommentThreadState) vt.state = t.isResolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
    prThreads.set(vt, { ghKey: `${t.path}:${t.line || t.originalLine}`, url: t.comments.nodes[0].url, path: t.path, line, status, who: t.comments.nodes[0].author?.login, first: cleanBody(t.comments.nodes[0].body, t.comments.nodes[0].url, 160) });
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function loadReview(root) {
  const file = path.join(root, REVIEW_FILE);
  const review = readJson(file);
  if (!review) throw new Error(`Could not read ${file}`);
  review.base = review.base || "HEAD";
  review.sections = review.sections || [];
  review.notes = (review.notes || []).map((n, i) => ({ id: n.id || `n${i + 1}`, ...n }));
  return { root, review, mtime: fs.statSync(file).mtimeMs };
}

const DATA_EXT = /\.(json|jsonl|csv|tsv|txt|log|lock|svg|excalidraw|ipynb|min\.js|map|snap)$/i;
const DATA_LINES = 800;

/** Binary files and big data dumps (benchmark JSON, logs, lockfiles) hide the real change. */
async function markGenerated(root, review, files) {
  const stat = (await git(root, ["diff", "--numstat", review.base, "--", ...files.map((f) => f.path)])) || "";
  const num = new Map();
  for (const l of stat.split("\n")) {
    const [a, d, p] = l.split("\t");
    if (p) num.set(p, { binary: a === "-", lines: (+a || 0) + (+d || 0) });
  }
  for (const f of files) {
    if (f.generated !== undefined) continue;
    let n = num.get(f.path);
    if (!n) {
      try {
        const buf = fs.readFileSync(path.join(root, f.path));
        n = { binary: buf.subarray(0, 8000).includes(0), lines: buf.toString("utf8").split("\n").length };
      } catch {
        n = { binary: false, lines: 0 };
      }
    }
    f.generated = n.binary || (DATA_EXT.test(f.path) && n.lines > DATA_LINES);
    f.lines = n.lines;
    f.binary = n.binary;
  }
  return files;
}

async function changedFiles(root, review) {
  const listed = (review.files || []).map((f) => (typeof f === "string" ? { path: f } : f));
  const tracked = (await git(root, ["diff", "--name-only", review.base])) || "";
  const untracked = (await git(root, ["ls-files", "--others", "--exclude-standard"])) || "";
  const seen = new Set(listed.map((f) => f.path));
  // Files the agent changed but did not list still belong in the review, flagged.
  const unlisted = [...new Set([...tracked.split("\n"), ...untracked.split("\n")])]
    .map((s) => s.trim())
    .filter((s) => s && !seen.has(s) && !s.startsWith(".review/") && !s.startsWith("graphify-out/"))
    .map((p) => ({ path: p, unlisted: listed.length > 0 }));
  return markGenerated(root, review, [...listed, ...unlisted]);
}

function relOf(uri) {
  if (!current || uri.scheme !== "file") return null;
  const rel = path.relative(current.root, uri.fsPath);
  return rel.startsWith("..") ? null : rel.split(path.sep).join("/");
}

function fileUri(rel) {
  return vscode.Uri.file(path.join(current.root, rel));
}

// ---------------------------------------------------------------- feedback

function feedbackPath() {
  return path.join(current.root, FEEDBACK_FILE);
}

function loadFeedback() {
  const fb = readJson(feedbackPath()) || {};
  fb.comments = fb.comments || {}; // note id -> [text]
  fb.extra = fb.extra || []; // [{file, line, text}] comments on un-noted lines
  for (const k of Object.keys(fb.comments)) if (typeof fb.comments[k] === "string") fb.comments[k] = [fb.comments[k]];
  return fb;
}

function saveFeedback(mutate) {
  const fb = loadFeedback();
  mutate(fb);
  fb.reviewOf = current.review.title || null;
  fb.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(feedbackPath()), { recursive: true });
  fs.writeFileSync(feedbackPath(), JSON.stringify(fb, null, 2) + "\n");
  if (panel) panel.webview.postMessage({ type: "count", n: countComments(fb) });
}

function countComments(fb) {
  return Object.values(fb.comments).reduce((a, v) => a + v.length, 0) + fb.extra.length + (fb.prReplies || []).length;
}

// ---------------------------------------------------------- comment threads

const md = (s) => {
  const m = new vscode.MarkdownString(s || "");
  m.supportThemeIcons = true;
  return m;
};
/** Inline notes stay short; anything longer is cut here and read in full in Deep dive. */
const NOTE_MAX = 280;
const clip = (s, max) => (s.length <= max ? s : s.slice(0, max).replace(/\s+\S*$/, "") + " …");
const noteComment = (n) => {
  const body = String(n.body || "");
  const more = body.length > NOTE_MAX || n.detail;
  return { body: md(clip(body, NOTE_MAX) + (more ? "\n\n*More in the Deep dive tab.*" : "")), mode: vscode.CommentMode.Preview, author: { name: "Why" }, contextValue: "note" };
};
const userComment = (text) => ({ body: md(text), mode: vscode.CommentMode.Preview, author: { name: "You" } });

function rebuildThreads() {
  for (const t of threads.values()) t.dispose();
  for (const t of userThreads) t.dispose();
  threads.clear();
  userThreads.clear();
  const fb = loadFeedback();
  for (const n of current.review.notes) {
    if (!n.file || !n.start) continue;
    const range = new vscode.Range(n.start - 1, 0, (n.end || n.start) - 1, 0);
    const replies = (fb.comments[n.id] || []).map(userComment);
    const t = ctrl.createCommentThread(fileUri(n.file), range, [noteComment(n), ...replies]);
    t.label = n.title || n.id;
    t.contextValue = n.id;
    t.canReply = true;
    t.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    threads.set(n.id, t);
  }
  for (const e of fb.extra) {
    const t = ctrl.createCommentThread(fileUri(e.file), new vscode.Range(e.line - 1, 0, e.line - 1, 0), [userComment(e.text)]);
    t.label = "Your comment";
    t.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    userThreads.add(t);
  }
}

function onReply(reply) {
  if (!current || !reply.text.trim()) return;
  const t = reply.thread;
  t.comments = [...t.comments, userComment(reply.text)];
  const noteId = t.contextValue && threads.has(t.contextValue) ? t.contextValue : null;
  if (checkThreads.has(t)) {
    const key = checkThreads.get(t);
    saveFeedback((fb) => (fb.comments[key] = [...(fb.comments[key] || []), reply.text]));
  } else if (prThreads.has(t)) {
    const info = prThreads.get(t);
    saveFeedback((fb) => (fb.prReplies = [...(fb.prReplies || []), { url: info.url, file: info.path, line: info.line, text: reply.text }]));
  } else if (noteId) {
    saveFeedback((fb) => (fb.comments[noteId] = [...(fb.comments[noteId] || []), reply.text]));
  } else {
    t.label = "Your comment";
    t.canReply = true;
    userThreads.add(t);
    const rel = relOf(t.uri);
    saveFeedback((fb) => fb.extra.push({ file: rel, line: t.range.start.line + 1, text: reply.text }));
  }
}

/** Clicking into a noted change opens its thread under the code. */
function onSelection(e) {
  if (!current) return;
  const rel = relOf(e.textEditor.document.uri);
  if (!rel) return;
  const line = e.selections[0].active.line;
  for (const [id, t] of threads) {
    const n = current.review.notes.find((x) => x.id === id);
    if (n.file === rel && t.range.start.line <= line && line <= t.range.end.line)
      t.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
  }
}

// ------------------------------------------------------------------- open

/** Every changed hunk, grouped into logical changes, and which ones no note explains. */
async function analyse() {
  const { root, review } = current;
  const files = review.files.filter((f) => !f.generated).map((f) => f.path);
  const diff = files.length ? (await git(root, ["diff", "-U0", "--no-color", review.base, "--", ...files])) || "" : "";
  const hunks = groups.parseDiff(diff);
  const tracked = new Set(hunks.map((h) => h.file));
  for (const f of files) {
    if (tracked.has(f)) continue;
    let lines = [];
    try {
      lines = fs.readFileSync(path.join(root, f), "utf8").split("\n");
    } catch {
      continue;
    }
    hunks.push({ file: f, start: 1, end: Math.max(1, lines.length), added: lines.length, removed: 0, text: lines, context: "" });
  }
  const order = review.order || [];
  const rank = (n) => (order.includes(n.id) ? order.indexOf(n.id) : order.length + review.notes.indexOf(n));
  const res = groups.group(root, hunks, [...review.notes].sort((a, b) => rank(a) - rank(b)));
  const lines = hunks.reduce((a, h) => a + h.added + h.removed, 0);
  current.analysis = { ...res, lines, sourceFiles: files.length, big: lines > BIG_LINES || files.length > BIG_FILES };
}
const BIG_LINES = 400;
const BIG_FILES = 10;
const groupResources = (g) =>
  g.files.map((f) => {
    const abs = fileUri(f);
    return [abs, baseUri(current.root, current.review.base, f), fs.existsSync(abs.fsPath) ? abs : undefined];
  });

async function openReview(root, { force = false } = {}) {
  let loaded;
  try {
    loaded = loadReview(root);
  } catch (e) {
    vscode.window.showErrorMessage(`Review Handoff: ${e.message}`);
    return;
  }
  const sameRun = current && current.root === root && current.mtime === loaded.mtime;
  current = loaded;
  current.review.files = await changedFiles(root, current.review);
  await analyse();
  rebuildThreads();
  addPrThreads();
  addCheckThreads();
  if (!plugins) detectPlugins();

  if (sameRun && !force && panel) {
    panel.webview.html = renderHtml(panel.webview);
    return;
  }

  // Room for the diff: no explorer, no chat column.
  await vscode.commands.executeCommand("workbench.action.closeSidebar");
  await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar").then(undefined, () => {});
  await vscode.commands.executeCommand("workbench.action.closePanel").then(undefined, () => {});

  const resources = current.review.files.filter((f) => !f.generated).map((f) => {
    const abs = fileUri(f.path);
    return [abs, baseUri(root, current.review.base, f.path), fs.existsSync(abs.fsPath) ? abs : undefined];
  });
  await vscode.commands.executeCommand("vscode.changes", `Review: ${current.review.title || path.basename(root)}`, resources);
  showPanel();
  await vscode.commands
    .executeCommand("vscode.setEditorLayout", { orientation: 0, groups: [{ size: 0.7 }, { size: 0.3 }] })
    .then(undefined, () => {});
  refreshPr();
}

async function refreshPr() {
  if (!current) return;
  const root = current.root;
  const fetched = await fetchPr(root, current.review.pr);
  if (!current || current.root !== root) return;
  pr = fetched;
  addPrThreads();
  if (panel) panel.webview.html = renderHtml();
}

async function openFile(rel, line) {
  const abs = fileUri(rel);
  const left = baseUri(current.root, current.review.base, rel);
  const pos = new vscode.Position(Math.max(0, (line || 1) - 1), 0);
  const opts = { selection: new vscode.Range(pos, pos), viewColumn: vscode.ViewColumn.One, preview: true };
  if (fs.existsSync(abs.fsPath)) await vscode.commands.executeCommand("vscode.diff", left, abs, `${rel} (review)`, opts);
  else await vscode.window.showTextDocument(left, opts);
}

// ------------------------------------------------------------------ panel

function showPanel() {
  if (!panel) {
    panel = vscode.window.createWebviewPanel(
      "reviewHandoff",
      "Overview",
      { viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true }
    );
    panel.onDidDispose(() => (panel = null));
    panel.webview.onDidReceiveMessage((msg) => {
      if (!current) return;
      if (msg.type === "open") openFile(msg.file, msg.line);
      if (msg.type === "external" && /^https:\/\/github\.com\//.test(msg.url)) vscode.env.openExternal(vscode.Uri.parse(msg.url));
      if (msg.type === "refreshPr") refreshPr();
      if (msg.type === "run") {
        if (msg.id !== "all") runJob(msg.id);
        else for (const id of [...Object.keys(REVIEWERS), "tests"]) {
          const r = REVIEWERS[id];
          const lastRun = readJson(path.join(checksDir(), "tests.json"));
          const blocked = (r?.plugin && plugins && !plugins.has(r.plugin.id) && id === "ponytail") || (id === "tests" && !(current.review.tests?.targets || lastRun?.targets || []).length);
          if (!blocked && jobState(id) !== "running") runJob(id);
        }
      }
      if (msg.type === "install") installPlugin(msg.id);
      if (msg.type === "diagramOpen") openDiagram(msg.what);
      if (msg.type === "testOn") saveFeedback((fb) => {
        const off = new Set(fb.testsOff || []);
        msg.on ? off.delete(msg.target) : off.add(msg.target);
        fb.testsOff = [...off];
      });
      if (msg.type === "ask") askQuestion(msg.q);
      if (msg.type === "switchTask") openReview(msg.root, { force: true });
      if (msg.type === "group") {
        const g = current.analysis?.groups[msg.i];
        if (g) vscode.commands.executeCommand("vscode.changes", `Group: ${g.title}`, groupResources(g));
      }
      if (msg.type === "graphify") {
        const bin = findBin("graphify");
        const t = terminal("Review · Graphify");
        t.sendText(`${bin === "graphify" ? `${shq(findBin("uv"))} tool install graphifyy && ` : ""}graphify update .`);
        jobs.set("graphify", { root: current.root, started: Date.now(), terminal: t });
      }
      if (msg.type === "tasks") vscode.commands.executeCommand("reviewHandoff.tasks");
      if (msg.type === "summon") vscode.commands.executeCommand("reviewHandoff.summonSkill");
      onHandback(msg);
    });
  } else {
    panel.reveal(vscode.ViewColumn.Two, true);
  }
  panel.title = `Review: ${current.review.title || path.basename(current.root)}`;
  panel.webview.html = renderHtml();
}

const EXCALIDRAW_EXT = "pomdtr.excalidraw-editor";

/** One chip per task that has a review, so you can move between parallel tasks. */
function taskStrip() {
  const items = tasks.strip(current.root);
  const chips = items
    .map((t) => `<button class="task ${t.root === current.root ? "on" : ""}" data-root="${esc(t.root)}" title="${esc(t.status)}">${esc(t.title)}${t.status === "ready for review" ? " ●" : ""}</button>`)
    .join("");
  return `<div class="strip">${chips}<span class="sp"></span><button class="task" data-tasks title="Tasks board">Tasks</button><button class="task" data-summon title="Summon a skill (⌥⌘K)">Skills</button></div>`;
}

async function openDiagram(what) {
  const dir = path.join(current.root, ".review");
  if (what === "install") return vscode.commands.executeCommand("workbench.extensions.search", EXCALIDRAW_EXT);
  const file = path.join(dir, what === "png" ? "diagram.png" : "diagram.excalidraw");
  if (!fs.existsSync(file)) return vscode.window.showWarningMessage(`Review Handoff: ${path.basename(file)} not found.`);
  await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(file), { viewColumn: vscode.ViewColumn.One });
}

/** Deep-dive questions need the agent's context, so they go to the user's own session. */
function askQuestion(q) {
  q = String(q || "").trim();
  if (!q) return;
  saveFeedback((fb) => (fb.questions = [...(fb.questions || []), { q, at: new Date().toISOString() }]));
  const prompt = `Review question waiting: read "questions" in ${feedbackPath()} and answer in review.json "qa" (review-handoff skill, job "answer").`;
  vscode.env.clipboard.writeText(prompt);
  vscode.window.showInformationMessage("Question saved. Prompt copied: paste it into your agent session.");
  rerender();
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const FILE_REF = /^([\w./-]+\.\w+)(?::(\d+))?$/;

function inline(s) {
  return esc(s)
    .split(/(`[^`]+`)/g)
    .map((part) => {
      if (part.length > 1 && part.startsWith("`") && part.endsWith("`")) {
        const inner = part.slice(1, -1);
        const m = inner.match(FILE_REF);
        if (m && current && fs.existsSync(path.join(current.root, m[1])))
          return `<a class="ref" data-file="${m[1]}" data-line="${m[2] || 1}"><code>${inner}</code></a>`;
        return `<code>${inner}</code>`;
      }
      return part
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>")
        .replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a class="ext" data-url="$2">$1</a>');
    })
    .join("");
}

/** Markdown subset: headings, paragraphs, lists, fences, tables, inline. */
function mdHtml(src) {
  const lines = String(src || "").replace(/\r/g, "").split("\n");
  const out = [];
  const isList = (l) => /^\s*([-*]|\d+\.) /.test(l);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
    } else if (/^#{1,4} /.test(line)) {
      out.push(`<h4>${inline(line.replace(/^#+ /, ""))}</h4>`);
      i++;
    } else if (/^\s*\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const [head, ...rest] = rows.filter((r, k) => !(k === 1 && /^[\s|:-]+$/.test(r)));
      out.push(
        `<table><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join("")}</tr>` +
          rest.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("") +
          "</table>"
      );
    } else if (isList(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items = [];
      while (i < lines.length && (isList(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (isList(lines[i])) items.push(lines[i].replace(/^\s*([-*]|\d+\.) /, ""));
        else items[items.length - 1] += " " + lines[i].trim();
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</${tag}>`);
    } else if (!line.trim()) {
      i++;
    } else {
      const buf = [];
      while (i < lines.length && lines[i].trim() && !/^(```|#{1,4} |\s*\|)/.test(lines[i]) && !isList(lines[i])) buf.push(lines[i++]);
      out.push(`<p>${inline(buf.join(" "))}</p>`);
    }
  }
  return out.join("\n");
}

// --------------------------------------------------------------- hand-back

const ACTIONS = {
  pr: [["fix", "Fix"], ["answer", "Explain / answer"], ["skip", "Skip"]],
  you: [["fix", "Fix"], ["answer", "Explain / answer"], ["skip", "Skip"]],
  check: [["fix", "Fix"], ["answer", "Explain why not"], ["skip", "Skip"]],
  change: [["keep", "Keep"], ["explain", "Explain it"], ["change", "Change it"], ["test", "Add / extend test"], ["revert", "Revert"]],
};
let lastItems = [];

/** Everything the user can tick: PR threads, reviewer findings, failing tests, their own comments, each change. */
function buildItems(fb) {
  const items = [];
  const order = { open: 0, outdated: 1, resolved: 2 };
  const triage = current.review.triage || {}; // "path:line" (GitHub line) -> {action, why}
  const done = current.review.done || {}; // item key -> what the agent did about it
  for (const r of [...prThreads.values()].sort((a, b) => order[a.status] - order[b.status])) {
    const tr = triage[r.ghKey];
    const def = tr?.action || (r.status === "open" ? "fix" : "skip");
    items.push({ key: `pr:${r.url}`, kind: "pr", label: `@${r.who}`, status: r.status, file: r.path, line: r.line, text: r.first, url: r.url, def, on: r.status === "open" && def !== "skip", why: tr?.why });
  }
  for (const id of Object.keys(REVIEWERS)) {
    const c = readCheck(id);
    for (const f of c?.findings || []) {
      const replies = fb.comments[`check:${id}:${f.id}`] || [];
      items.push({ key: `check:${id}:${f.id}`, kind: "check", label: REVIEWERS[id].name, status: SEV[f.severity], sev: f.severity, file: f.file, line: f.line, text: f.title + (replies.length ? ` · you: ${replies[replies.length - 1]}` : ""), def: f.severity === "nit" ? "skip" : "fix", on: f.severity === "must" });
    }
  }
  const tests = readJson(path.join(checksDir(), "tests.json"));
  for (const x of tests?.failures || [])
    items.push({ key: `fail:${x.test}`, kind: "check", label: "test failed", status: "must fix", sev: "must", text: `\`${x.test}\` ${x.message.split("\n")[0]}`, def: "fix", on: true });
  for (const e of fb.extra) items.push({ key: `you:${e.file}:${e.line}`, kind: "you", label: "you", file: e.file, line: e.line, text: e.text, def: "fix", on: true });
  for (const r of fb.prReplies || []) items.push({ key: `reply:${r.url}:${r.text.slice(0, 20)}`, kind: "you", label: "you, on PR thread", file: r.file, line: r.line, text: r.text, def: "fix", on: true });
  for (const n of current.review.notes) {
    const replies = fb.comments[n.id] || [];
    items.push({ key: `note:${n.id}`, kind: "change", label: "change", file: n.file, line: n.start, text: n.title + (replies.length ? ` · your reply: ${replies[replies.length - 1]}` : ""), def: replies.length ? "change" : "keep", on: replies.length > 0 });
    if (n.test) items.push({ key: `test:${n.id}`, kind: "change", label: "suggested test", file: n.file, line: n.start, text: n.test, def: "test", on: false });
  }
  const an = current.analysis;
  if (an) {
    for (const h of an.unexplained)
      items.push({ key: `hunk:${h.file}:${h.start}`, kind: "change", label: "no note", file: h.file, line: h.start, text: `Lines ${h.start}-${h.end} changed with no explanation (+${h.added} -${h.removed})`, def: "explain", on: false });
    if (an.big)
      items.unshift({ key: "meta:split", kind: "change", label: "whole change", text: `${an.lines} changed lines in ${an.sourceFiles} source files. Split into smaller steps I can review one at a time.`, def: "change", on: false });
  }
  for (const it of items) {
    it.done = done[it.key];
    if (it.done) it.on = false; // the agent says it's handled; tick again to reopen
    const saved = (fb.plan || {})[it.key];
    it.action = saved?.action || it.def;
    it.checked = saved && saved.round === fb.round ? !!saved.on : it.on;
    it.note = saved?.note || "";
  }
  return items;
}

function handbackHtml(fb) {
  lastItems = buildItems(fb);
  const ctx = fb.context || {};
  const ref = (it) => (it.file ? `<a class="ref" data-file="${esc(it.file)}" data-line="${it.line || 1}">${esc(path.basename(it.file))}:${it.line || 1}</a>` : "");
  const row = (it) => `<div class="item ${it.checked ? "" : "off"}" data-key="${esc(it.key)}">
      <input type="checkbox" class="on" ${it.checked ? "checked" : ""} aria-label="act on this">
      <div class="item-main">
        <div><span class="tag ${it.kind} ${it.status === "open" || it.sev === "must" ? "hot" : ""}">${esc(it.label)}${it.status ? ` · ${esc(it.status)}` : ""}</span>${ref(it)}</div>
        <div class="first">${inline(String(it.text).replace(/\n+/g, " "))}</div>
        ${it.done ? `<div class="done">✓ Done: ${inline(it.done)}</div>` : ""}
        ${it.why ? `<div class="why">Agent: ${inline(it.why)}</div>` : ""}
        <div class="ctl"><select class="act" aria-label="action">${ACTIONS[it.kind].map(([v, l]) => `<option value="${v}" ${v === it.action ? "selected" : ""}>${l}</option>`).join("")}</select>
        <input class="note" placeholder="how / what to test (optional)" value="${esc(it.note)}"></div>
      </div></div>`;
  const groups = [
    ["PR comments", lastItems.filter((i) => i.kind === "pr")],
    ["Reviewers and tests", lastItems.filter((i) => i.kind === "check")],
    ["Your comments", lastItems.filter((i) => i.kind === "you")],
    ["Changes", lastItems.filter((i) => i.kind === "change")],
  ]
    .filter(([, l]) => l.length)
    .map(([h, l]) => `<details class="grp" ${l.some((i) => i.checked) || h === "PR comments" ? "open" : ""}><summary>${h} <span class="small">${l.filter((i) => i.checked).length}/${l.length} ticked</span></summary>${l.map(row).join("")}</details>`)
    .join("");
  const n = lastItems.filter((i) => i.checked && !["skip", "keep"].includes(i.action)).length;
  return `<div class="small">Round ${(fb.round || 0) + 1}. Tick what the agent should act on and choose how. Everything saves as you go.</div>
  ${groups || `<p class="small">Nothing to act on yet.</p>`}
  <label class="lbl" for="ctx-instructions">Instructions for this round</label>
  <textarea class="ctx" id="ctx-instructions" data-k="instructions" placeholder="e.g. keep the fix minimal, don't touch the gateway">${esc(ctx.instructions || "")}</textarea>
  <label class="lbl" for="ctx-clarifications">Clarifications</label>
  <textarea class="ctx" id="ctx-clarifications" data-k="clarifications" placeholder="Answers to open questions, or what the task really is">${esc(ctx.clarifications || "")}</textarea>
  <label class="lbl" for="ctx-remember">Remember for future sessions</label>
  <textarea class="ctx" id="ctx-remember" data-k="remember" placeholder="One per line. The agent saves these to its memory.">${esc(ctx.remember || "")}</textarea>
  <div class="row"><button class="primary" id="send">Send ${n} to agent</button><button data-v="approve" title="Commit the reviewed files and push this branch (asks first)">Approve &amp; push</button></div>
  <div class="small" id="sent">${fb.pushed ? `Pushed ${esc(fb.pushed.sha)} to ${esc(fb.pushed.remote)}/${esc(fb.pushed.branch)} · ` : ""}${fb.submittedAt ? `Last sent ${esc(fb.submittedAt.slice(0, 16).replace("T", " "))}` : ""}</div>`;
}

/** Approve & push: commit only the reviewed files and push the branch, after a modal confirm. */
async function approveAndPush() {
  const root = current.root;
  const branch = ((await git(root, ["rev-parse", "--abbrev-ref", "HEAD"])) || "").trim();
  if (!branch || branch === "HEAD" || ["main", "master"].includes(branch))
    return vscode.window.showErrorMessage(`Approve & push: refusing to push from "${branch || "detached HEAD"}". Use a feature branch.`);
  const upstream = ((await git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"])) || "").trim();
  const [remote, remoteBranch] = upstream ? [upstream.split("/")[0], upstream.split("/").slice(1).join("/")] : ["origin", branch];
  const files = current.review.files.map((f) => f.path);
  const dirty = ((await git(root, ["status", "--porcelain", "--", ...files])) || "").trim();

  let message = null;
  if (dirty) {
    message = await vscode.window.showInputBox({
      title: "Approve & push: commit message",
      value: current.review.commit?.message || current.review.title || "",
      prompt: `Commits ${files.length} reviewed file(s) on ${branch}`,
      ignoreFocusOut: true,
    });
    if (!message) return;
  }
  const detail = [
    dirty ? `Commit: "${message.split("\n")[0]}"` : "Nothing to commit; pushing existing commits.",
    `Files: ${files.join(", ")}`,
    `Push: ${branch} → ${remote}/${remoteBranch} (no force)`,
  ].join("\n\n");
  const ok = await vscode.window.showWarningMessage("Approve & push?", { modal: true, detail }, "Approve & push");
  if (ok !== "Approve & push") return;

  const run = (args) =>
    new Promise((resolve) => cp.execFile("git", args, { cwd: root, maxBuffer: 64 << 20 }, (err, out, errOut) => resolve({ err, out: (out || "") + (errOut || "") })));
  if (dirty) {
    let r = await run(["add", "--", ...files]);
    if (!r.err) r = await run(["commit", "-m", message, "--", ...files]);
    if (r.err) return vscode.window.showErrorMessage(`Commit failed: ${r.out.trim().split("\n").pop()}`);
  }
  const r = await run(["push", remote, `HEAD:${remoteBranch}`]);
  if (r.err) return vscode.window.showErrorMessage(`Push failed: ${r.out.trim().split("\n").pop()}`);
  const sha = ((await git(root, ["rev-parse", "--short", "HEAD"])) || "").trim();
  saveFeedback((fb) => {
    fb.verdict = "approve";
    fb.pushed = { sha, remote, branch: remoteBranch, at: new Date().toISOString() };
  });
  vscode.window.showInformationMessage(`Pushed ${sha} to ${remote}/${remoteBranch}.`);
  if (panel) panel.webview.html = renderHtml();
}

function onHandback(msg) {
  if (msg.type === "verdict" && msg.verdict === "approve") return approveAndPush();
  if (msg.type === "plan") saveFeedback((fb) => ((fb.plan = fb.plan || {})[msg.key] = { on: msg.on, action: msg.action, note: msg.note, round: fb.round }));
  if (msg.type === "ctx") saveFeedback((fb) => ((fb.context = fb.context || {})[msg.k] = msg.text));
  if (msg.type === "send") {
    let todo = [];
    saveFeedback((fb) => {
      todo = buildItems(fb)
        .filter((i) => i.checked && !["skip", "keep"].includes(i.action))
        .map(({ key, kind, label, status, file, line, text, url, action, note }) => ({ key, kind, from: label, status, file, line, text, url, action, note }));
      fb.todo = todo;
      fb.verdict = todo.length ? "request-changes" : "approve";
      fb.remember = String(fb.context?.remember || "").split("\n").map((x) => x.trim()).filter(Boolean);
      fb.submittedAt = new Date().toISOString();
      fb.round = (fb.round || 0) + 1;
    });
    const prompt = `Review handoff ready: read ${feedbackPath()} and act on it (${todo.length} item${todo.length === 1 ? "" : "s"}).`;
    vscode.env.clipboard.writeText(prompt);
    vscode.window.showInformationMessage(`Sent ${todo.length} item(s). Prompt copied: paste it into your agent session.`);
    rerender();
  }
}

function prHtml() {
  if (!pr) return "";
  if (pr.error) return `<h2>PR</h2><p class="small">Couldn't load: ${esc(pr.error)} · <a class="ext" data-url="${esc(pr.url)}">open PR</a> · <a id="refresh-pr">retry</a></p>`;
  const open = [...prThreads.values()].filter((r) => r.status === "open").length;
  const disc = pr.discussion
    .map((d) => `<div class="disc"><span class="who">@${esc(d.who)}</span> <span class="small">${esc(d.kind)} · ${esc(d.when.slice(0, 10))} · <a class="ext" data-url="${esc(d.url)}">GitHub</a></span>${mdHtml(cleanBody(d.body, d.url, 600))}</div>`)
    .join("");
  return `<h2>PR #${pr.number} · ${open} open thread${open === 1 ? "" : "s"} · <a id="refresh-pr">refresh</a> · <a class="ext" data-url="${esc(pr.url)}">GitHub</a></h2>
  <div class="small">Threads are inline in the diff. Replies you type there are saved for the agent, never posted.</div>
  ${disc ? `<details><summary>Conversation (${pr.discussion.length})</summary>${disc}</details>` : ""}`;
}

// ------------------------------------------------------------------ panes

const words = (s) => String(s || "").split(/\s+/).filter(Boolean).length;
const LEAD_WORDS = 70;
const when = (ms) => new Date(ms).toTimeString().slice(0, 5);

/** One status line per check, for Overview and the tab badge. */
function checkSummary() {
  const out = [];
  let must = 0;
  for (const [id, r] of Object.entries(REVIEWERS)) {
    const c = readCheck(id);
    const st = jobState(id);
    if (st === "running") out.push(`${r.name}: running`);
    else if (c) {
      const m = c.findings.filter((f) => f.severity === "must").length;
      must += m;
      out.push(`${r.name}: ${c.findings.length ? `${c.findings.length} finding${c.findings.length === 1 ? "" : "s"}${m ? ` (${m} must fix)` : ""}` : "clean"}`);
    }
  }
  const t = readJson(path.join(checksDir(), "tests.json"));
  if (t?.running) out.push("tests: running");
  else if (t) {
    out.push(`tests: ${t.passed} passed${t.failed + t.errors ? `, ${t.failed + t.errors} failed` : ""}`);
    must += t.failed + t.errors;
  }
  return { text: out.join(" · "), must };
}

/** The one thing to do now, so the user never has to work out where they are in the loop. */
function nextStep(fb) {
  const cs = checkSummary();
  const ran = Object.keys(REVIEWERS).some((id) => readCheck(id)) || readJson(path.join(checksDir(), "tests.json"));
  const ticked = buildItems(fb).filter((i) => i.checked && !["skip", "keep"].includes(i.action)).length;
  if (fb.pushed) return { text: `Pushed ${fb.pushed.sha} to ${fb.pushed.remote}/${fb.pushed.branch}.`, tab: "", label: "" };
  if (cs.must) return { text: `${cs.must} must-fix ${cs.must === 1 ? "finding" : "findings"} from checks.`, tab: "checks", label: "See checks" };
  if (fb.submittedAt && fb.verdict === "request-changes" && Date.parse(fb.submittedAt) > current.mtime)
    return { text: "Sent to the agent. This review updates when it writes a new one.", tab: "", label: "" };
  if (!ran) return { text: "Read the diff, then run independent checks before you decide.", tab: "checks", label: "Run checks" };
  if (ticked) return { text: `${ticked} ${ticked === 1 ? "item is" : "items are"} ticked for the agent.`, tab: "handback", label: "Hand back" };
  return { text: "Nothing flagged. Approve and push, or tick items to send back.", tab: "handback", label: "Decide" };
}

function overviewHtml(review, fb) {
  const [first] = review.sections;
  const nx = nextStep(fb);
  const notesPer = new Map();
  for (const n of review.notes) notesPer.set(n.file, (notesPer.get(n.file) || 0) + 1);
  let lead = "";
  if (first) {
    const long = words(first.body) > LEAD_WORDS;
    lead = long
      ? `<div class="lead">${mdHtml(first.body.split(/\s+/).slice(0, LEAD_WORDS).join(" ") + " …")}</div><div class="warn">The summary runs ${words(first.body)} words (limit ${LEAD_WORDS}). The rest is in <a data-tab="deep">Deep dive</a>.</div>`
      : `<div class="lead">${mdHtml(first.body)}</div>`;
  }
  const gen = review.files.filter((f) => f.generated);
  const files = review.files
    .filter((f) => !f.generated)
    .map(
      (f) => `<li><a class="ref" data-file="${esc(f.path)}" data-line="1">${esc(path.basename(f.path))}</a>
        ${notesPer.get(f.path) ? `<span class="pill">${notesPer.get(f.path)}</span>` : ""}
        ${f.summary ? `<span class="sum">${inline(clip(f.summary, 60))}</span>` : f.unlisted ? `<span class="sum warnc">not mentioned by the agent</span>` : ""}</li>`
    )
    .join("");
  const cs = checkSummary();
  const qa = (review.qa || []).length;
  const an = current.analysis;
  const explained = an ? an.total - an.unexplained.length : 0;
  const grp = an
    ? `<h2>Changes, grouped <span class="small">${an.groups.length} ${an.groups.length === 1 ? "group" : "groups"} from ${an.total} hunks${an.graph ? ", linked by Graphify" : ""}</span></h2>
      ${an.big ? `<div class="warn">Large change: ${an.lines} lines in ${an.sourceFiles} source files. Review one group at a time, or ask for smaller steps in <a data-tab="handback">Hand back</a>.</div>` : ""}
      <ol class="groups">${an.groups
        .map(
          (g, i) => `<li><div class="g-h"><strong>${inline(g.title)}</strong><button class="ghost" data-group="${i}" title="Open only this group's diffs">Open</button></div>
          <div class="g-refs">${g.hunks.map((h) => `<a class="ref" data-file="${esc(h.file)}" data-line="${h.start}">${esc(path.basename(h.file))}:${h.start}</a>${h.explained || !/\.(py|[jt]sx?|go|rs|java|kt|c|cc|cpp|h|hpp|rb|swift|cs|php|scala|sh)$/.test(h.file) ? "" : `<span class="nonote" title="No note explains this hunk">?</span>`}`).join(" ")}</div>
          ${g.why.length > 1 ? `<div class="small">linked by ${g.why.slice(0, 3).map((w) => `<code>${esc(clip(w, 40))}</code>`).join(", ")}</div>` : ""}</li>`
        )
        .join("")}</ol>
      <p class="small">${explained} of ${an.total} changed blocks are explained by a note.${an.unexplained.length ? ` The others are marked ? and listed in <a data-tab="handback">Hand back</a>.` : ""}${an.graph ? "" : ` <a data-graphify>Link groups by call graph with Graphify</a>`}</p>`
    : "";
  return `<div class="next"><span>${esc(nx.text)}</span>${nx.tab ? `<button class="primary" data-tab="${nx.tab}">${nx.label}</button>` : ""}</div>
  ${lead}
  ${grp}
  <div class="how">Click into a change to open its note under the code. Reply there, or hover a line and click <strong>+</strong> to comment.</div>
  <h2>Files</h2><ul class="files">${files}</ul>
  ${gen.length ? `<details class="gen"><summary>Data and generated files (${gen.length}), left out of the diff view</summary><ul class="files">${gen
    .map((f) => `<li><a class="ref" data-file="${esc(f.path)}" data-line="1">${esc(f.path)}</a> <span class="sum">${f.binary ? "binary" : `${f.lines} lines`}${f.summary ? `, ${inline(clip(f.summary, 60))}` : ""}</span></li>`)
    .join("")}</ul></details>` : ""}
  <h2>Checks</h2><p class="small">${cs.text ? inline(cs.text) : `None run yet. <a data-tab="checks">Run reviewers or tests</a>`}</p>
  ${prHtml()}
  ${review.sections.length > 1 || review.deepDive || qa ? `<p class="small">Why this approach, why not shorter, the tests, and your questions are in <a data-tab="deep">Deep dive</a>.</p>` : ""}`;
}

function deepHtml(review, fb) {
  const [, ...rest] = review.sections;
  const sec = [...rest, ...(review.deepDive || [])]
    .map((s) => `<details open><summary>${esc(s.heading)}</summary><div class="body">${mdHtml(s.body)}</div></details>`)
    .join("");
  const notes = [...review.notes]
    .sort((a, b) => (review.order ? review.order.indexOf(a.id) - review.order.indexOf(b.id) : 0))
    .map(
      (n, i) => `<div class="walk"><div><span class="num">${i + 1}</span><strong>${esc(n.title || n.id)}</strong>
        <a class="ref" data-file="${esc(n.file)}" data-line="${n.start}">${esc(path.basename(n.file))}:${n.start}</a></div>
        ${mdHtml(n.body)}${n.detail ? mdHtml(n.detail) : ""}</div>`
    )
    .join("");
  const answered = new Set((review.qa || []).map((x) => x.q.trim()));
  const pending = (fb.questions || []).filter((x) => !answered.has(x.q.trim()));
  const qa = [
    ...(review.qa || []).map((x) => `<div class="qa"><div class="q">${inline(x.q)}</div>${mdHtml(x.a)}</div>`),
    ...pending.map((x) => `<div class="qa"><div class="q">${inline(x.q)}</div><p class="small">Waiting for the agent.</p></div>`),
  ].join("");
  return `${sec || `<p class="small">The agent wrote no long-form sections.</p>`}
  <h2>Walkthrough, in reading order</h2>${notes || `<p class="small">No notes.</p>`}
  <h2>Ask about this change</h2>
  ${qa}
  <label class="lbl" for="q">Your question</label>
  <textarea id="q" placeholder="e.g. What happens to callers that still expect a str? Why not do this in the gateway?"></textarea>
  <div class="row"><button class="primary" id="ask">Ask the agent</button></div>
  <div class="small">Questions go to your own agent session, which has the context. The answer appears here.</div>`;
}

function diagramHtml(webview) {
  const dir = path.join(current.root, ".review");
  const png = path.join(dir, "diagram.png");
  const has = fs.existsSync(png);
  const st = jobState("diagram");
  const editor = !!vscode.extensions.getExtension(EXCALIDRAW_EXT);
  const img = has ? `<img class="diagram" alt="Diagram of the change" src="${webview.asWebviewUri(vscode.Uri.file(png))}?v=${fs.statSync(png).mtimeMs}">` : "";
  return `${img || `<p class="small">No diagram yet. The excalidraw-diagram skill draws the change as before and after flow, with the real function names, and renders it to PNG.</p>`}
  <div class="row">
    <button class="primary" data-run="diagram" ${st === "running" ? "disabled" : ""}>${st === "running" ? "Drawing…" : has ? "Redraw" : "Draw diagram"}</button>
    ${has ? `<button data-dg="png">Open full size</button>` : ""}
    ${fs.existsSync(path.join(dir, "diagram.excalidraw")) ? (editor ? `<button data-dg="excalidraw">Edit in Excalidraw</button>` : `<button data-dg="install">Get the Excalidraw editor</button>`) : ""}
  </div>
  <div class="small">Runs a fresh Claude session in a terminal, so it doesn't use your main session's context.</div>`;
}

function checksHtml(fb) {
  const cards = Object.entries(REVIEWERS)
    .map(([id, r]) => {
      const c = readCheck(id);
      const st = jobState(id);
      const missing = r.plugin && plugins && !plugins.has(r.plugin.id);
      const list = (c?.findings || [])
        .map(
          (f) => `<div class="finding"><span class="tag check ${f.severity === "must" ? "hot" : ""}">${SEV[f.severity]}</span>
          ${f.file ? `<a class="ref" data-file="${esc(f.file)}" data-line="${f.line || 1}">${esc(path.basename(f.file))}:${f.line || 1}</a>` : ""}
          <div><strong>${inline(f.title || "")}</strong></div><div class="small">${inline(clip(String(f.body || ""), 400))}</div></div>`
        )
        .join("");
      const status = st === "running" ? "running…" : c ? `ran ${when(c.mtime)} · ${c.findings.length ? `${c.findings.length} finding${c.findings.length === 1 ? "" : "s"}` : "no findings"}` : "not run";
      return `<div class="card"><div class="card-h"><strong>${r.name}</strong> <span class="small">${status}</span>
        <span class="sp"></span>
        ${missing ? `<button data-install="${id}">Install ${r.plugin.label}</button>` : ""}
        <button data-run="${id}" ${st === "running" || (missing && id === "ponytail") ? "disabled" : ""}>${c ? "Re-run" : "Run"}</button></div>
        <div class="small">${esc(r.blurb)}${missing ? ` ${esc(r.plugin.without)}` : ""}</div>
        ${c?.summary ? `<p>${inline(c.summary)}</p>` : ""}${list}</div>`;
    })
    .join("");

  const t = readJson(path.join(checksDir(), "tests.json"));
  const tests = { ...(t?.targets ? { targets: t.targets } : {}), ...(current.review.tests || {}) };
  const off = new Set(fb.testsOff || []);
  const st = jobState("tests");
  const targets = (tests.targets || [])
    .map((x) => `<label class="tgt"><input type="checkbox" data-target="${esc(x)}" ${off.has(x) ? "" : "checked"}> <code>${esc(x)}</code></label>`)
    .join("");
  const result = t && !t.running
    ? `<p><strong>${t.passed} passed</strong>${t.failed + t.errors ? `, <strong class="bad">${t.failed + t.errors} failed</strong>` : ""}${t.skipped ? `, ${t.skipped} skipped` : ""} <span class="small">· ${esc(t.where || "")} · ${esc(String(t.ranAt || "").slice(11, 16))}</span></p>
       ${(t.failures || []).map((f) => `<div class="finding"><code>${esc(f.test)}</code><pre>${esc(f.message)}</pre></div>`).join("")}
       ${t.tail ? `<details><summary>Output</summary><pre>${esc(t.tail)}</pre></details>` : ""}`
    : "";
  const testCard = `<div class="card"><div class="card-h"><strong>Tests on Modal CPU</strong> <span class="small">${st === "running" ? "running…" : t ? "" : "not run"}</span><span class="sp"></span>
      <button data-run="tests" ${st === "running" || !targets ? "disabled" : ""}>${t ? "Re-run" : "Run"}</button></div>
      <div class="small">Only the ticked targets run, never the full suite. ${tests.why ? inline(tests.why) : ""}</div>
      ${targets || `<p class="small">The agent listed no test targets (review.json "tests").</p>`}${result}</div>`;

  return `<div class="next"><span>Each check runs in its own terminal, where you can watch it and approve tool use. Findings appear here, inline in the diff, and in Hand back.</span><button class="primary" data-run="all">Run all checks</button></div>
  ${cards}${testCard}`;
}

function renderHtml() {
  const { review } = current;
  const fb = loadFeedback();
  const webview = panel.webview;
  webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(path.join(current.root, ".review"))] };
  const nonce = crypto.randomBytes(16).toString("hex");
  const cs = checkSummary();
  const panes = { overview: overviewHtml(review, fb), deep: deepHtml(review, fb), diagram: diagramHtml(webview), checks: checksHtml(fb), handback: handbackHtml(fb) };
  const tabs = [
    ["overview", "Overview", ""],
    ["deep", "Deep dive", ""],
    ["diagram", "Diagram", ""],
    ["checks", "Checks", cs.must ? String(cs.must) : ""],
    ["handback", "Hand back", String(lastItems.filter((i) => i.checked && !["skip", "keep"].includes(i.action)).length || "")],
  ];
  const strip = taskStrip();

  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); padding: 0 16px 32px; line-height: 1.5; }
  h1 { font-size: 15px; margin: 10px 0 2px; }
  h4 { font-size: 13px; margin: 10px 0 4px; }
  p, ul, ol { margin: 6px 0; } ul, ol { padding-left: 18px; } li { margin: 2px 0; }
  .meta { color: var(--vscode-descriptionForeground); font-size: 12px; margin-bottom: 6px; }
  .how { font-size: 12px; color: var(--vscode-descriptionForeground); background: var(--vscode-textBlockQuote-background); border-left: 2px solid var(--vscode-focusBorder); padding: 6px 8px; margin: 10px 0; }
  .warn { font-size: 12px; border-left: 2px solid var(--vscode-editorWarning-foreground); padding: 2px 8px; margin: 6px 0; color: var(--vscode-descriptionForeground); }
  code { font-family: var(--vscode-editor-font-family); font-size: 12px; background: var(--vscode-textCodeBlock-background); padding: 0 3px; border-radius: 3px; }
  pre { background: var(--vscode-textCodeBlock-background); padding: 6px 8px; overflow-x: auto; border-radius: 4px; font-size: 12px; white-space: pre-wrap; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; margin: 6px 0; font-size: 12px; }
  th, td { border: 1px solid var(--vscode-panel-border); padding: 2px 6px; text-align: left; vertical-align: top; }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
  a:hover { text-decoration: underline; }
  h2 { font-size: 12px; font-weight: 600; margin: 20px 0 6px; }
  .meta { display: flex; flex-wrap: wrap; gap: 2px 14px; }
  .next { display: flex; align-items: center; gap: 12px; justify-content: space-between; padding: 8px 10px; margin: 4px 0 10px; border-radius: 4px; background: var(--vscode-textBlockQuote-background); font-size: 12px; }
  .next button { flex: none; }
  .warnc { color: var(--vscode-editorWarning-foreground); }
  details.gen > summary { font-weight: 400; font-size: 12px; color: var(--vscode-descriptionForeground); }
  .groups { padding-left: 18px; margin: 4px 0; } .groups li { margin: 0 0 8px; }
  .g-h { display: flex; align-items: center; gap: 8px; } .g-h strong { flex: 1; }
  button.ghost { background: none; color: var(--vscode-textLink-foreground); padding: 2px 6px; }
  .g-refs { font-size: 12px; line-height: 1.7; }
  .nonote { font-size: 10px; font-weight: 600; color: var(--vscode-editorWarning-foreground); margin-left: 1px; vertical-align: super; }
  .item.off .ctl { display: none; }
  .lbl { display: block; font-size: 12px; font-weight: 600; margin: 14px 0 4px; }
  button:active:not(:disabled) { transform: translateY(1px); }
  @media (prefers-reduced-motion: reduce) { button:active:not(:disabled) { transform: none; } }
  h3 { font-size: 12px; margin: 14px 0 4px; }
  details { border-top: 1px solid var(--vscode-panel-border); padding: 6px 0; }
  summary { cursor: pointer; font-weight: 600; }
  .body { padding: 2px 0 4px 2px; }
  .files { list-style: none; padding: 0; } .files li { margin: 3px 0; }
  .sum { color: var(--vscode-descriptionForeground); font-size: 12px; margin-left: 6px; }
  .pill { font-size: 11px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 8px; padding: 0 6px; margin-left: 4px; }
  textarea { width: 100%; box-sizing: border-box; min-height: 48px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); font-family: inherit; font-size: 13px; padding: 6px; resize: vertical; }
  .row { display: flex; gap: 6px; margin: 8px 0 4px; flex-wrap: wrap; }
  button { border: 0; padding: 4px 12px; border-radius: 4px; cursor: pointer; font-size: 12px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button:disabled { opacity: .5; cursor: default; }
  button:focus-visible, a:focus-visible, input:focus-visible, select:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  .disc { border-top: 1px solid var(--vscode-panel-border); padding: 4px 0; font-size: 12px; } .who { font-weight: 600; }
  .small { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .tabs { position: sticky; top: 0; z-index: 2; background: var(--vscode-editor-background); display: flex; gap: 2px; border-bottom: 1px solid var(--vscode-panel-border); margin: 0 -16px 8px; padding: 0 12px; }
  .tab { background: none; color: var(--vscode-descriptionForeground); border-radius: 0; padding: 7px 8px 6px; border-bottom: 2px solid transparent; font-size: 12px; }
  .tab.on { color: var(--vscode-foreground); border-bottom-color: var(--vscode-focusBorder); }
  .tab .b { font-size: 10px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); border-radius: 8px; padding: 0 5px; margin-left: 4px; }
  .pane { display: none; } .pane.on { display: block; }
  .strip { display: flex; gap: 4px; overflow-x: auto; padding: 8px 0 2px; align-items: center; } .strip .sp { flex: 1; }
  .task { font-size: 11px; padding: 2px 10px; border-radius: 999px; white-space: nowrap; }
  .task.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .item { display: flex; gap: 8px; align-items: flex-start; padding: 6px 0; border-bottom: 1px solid var(--vscode-panel-border); font-size: 12px; }
  .item.off { opacity: .55; } .item input.on { margin-top: 3px; }
  .item-main { flex: 1; min-width: 0; }
  .item .first { margin: 2px 0 4px; overflow-wrap: anywhere; }
  .why { color: var(--vscode-descriptionForeground); font-style: italic; font-size: 11px; margin-bottom: 4px; }
  .done { color: var(--vscode-testing-iconPassed, #3fb950); font-size: 11px; margin-bottom: 4px; }
  .grp > summary { font-size: 12px; }
  .ctl { display: flex; gap: 6px; }
  select, input.note { background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); font-size: 12px; padding: 2px 4px; }
  input.note { flex: 1; min-width: 0; }
  .tag { font-size: 11px; border-radius: 8px; padding: 0 6px; margin-right: 6px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .tag.hot { background: var(--vscode-statusBarItem-warningBackground, #b58900); color: var(--vscode-statusBarItem-warningForeground, #fff); }
  .tag.you { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .card { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 8px 10px; margin: 10px 0; }
  .card-h { display: flex; align-items: center; gap: 8px; } .sp { flex: 1; }
  .finding { border-top: 1px solid var(--vscode-panel-border); padding: 6px 0; font-size: 12px; }
  .tgt { display: block; font-size: 12px; margin: 2px 0; }
  .bad { color: var(--vscode-testing-iconFailed, #f85149); }
  .walk { border-top: 1px solid var(--vscode-panel-border); padding: 6px 0; }
  .walk .ref { margin-left: 6px; font-size: 12px; }
  .num { display: inline-block; min-width: 16px; font-size: 11px; color: var(--vscode-descriptionForeground); }
  .qa { border-left: 2px solid var(--vscode-focusBorder); padding: 2px 8px; margin: 8px 0; } .q { font-weight: 600; }
  img.diagram { max-width: 100%; border-radius: 4px; background: #fff; margin: 8px 0; cursor: zoom-in; }
</style></head><body>
${strip}
<h1>${esc(review.title || "Review")}</h1>
<div class="meta"><span>against <code>${esc(/^[0-9a-f]{40}$/.test(review.base) ? review.base.slice(0, 7) : review.base)}</code></span><span>${review.files.length} files</span><span>${review.notes.length} notes</span><span><span id="count">${countComments(fb)}</span> comments from you</span>${fb.verdict ? `<span><strong>${fb.verdict === "approve" ? "approved" : "changes requested"}</strong></span>` : ""}</div>
<nav class="tabs" role="tablist">${tabs.map(([id, label, b]) => `<button class="tab" role="tab" aria-controls="pane-${id}" id="tab-${id}" data-tab="${id}">${label}${b ? `<span class="b">${esc(b)}</span>` : ""}</button>`).join("")}</nav>
${Object.entries(panes).map(([id, html]) => `<section class="pane" id="pane-${id}" role="tabpanel">${html}</section>`).join("")}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const state = vscode.getState() || {};
  const show = (id) => {
    document.querySelectorAll('.tab').forEach((t) => { t.classList.toggle('on', t.dataset.tab === id); t.setAttribute('aria-selected', t.dataset.tab === id); t.tabIndex = t.dataset.tab === id ? 0 : -1; });
    document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p.id === 'pane-' + id));
    vscode.setState({ ...vscode.getState(), tab: id });
  };
  show(state.tab || 'overview');
  document.querySelector('.tabs').addEventListener('keydown', (e) => {
    const ids = [...document.querySelectorAll('.tab')].map((t) => t.dataset.tab);
    const i = ids.indexOf(vscode.getState().tab);
    const j = e.key === 'ArrowRight' ? (i + 1) % ids.length : e.key === 'ArrowLeft' ? (i + ids.length - 1) % ids.length : -1;
    if (j >= 0) { show(ids[j]); document.getElementById('tab-' + ids[j]).focus(); }
  });
  window.scrollTo(0, state.scroll || 0);
  addEventListener('scroll', () => vscode.setState({ ...vscode.getState(), scroll: scrollY }));
  document.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-tab]');
    if (tab) return show(tab.dataset.tab);
    const ext = e.target.closest('a.ext');
    if (ext) return vscode.postMessage({ type: 'external', url: ext.dataset.url });
    if (e.target.closest('#refresh-pr')) return vscode.postMessage({ type: 'refreshPr' });
    const ref = e.target.closest('a.ref');
    if (ref) return vscode.postMessage({ type: 'open', file: ref.dataset.file, line: +ref.dataset.line });
    const task = e.target.closest('[data-root]');
    if (task) return vscode.postMessage({ type: 'switchTask', root: task.dataset.root });
    if (e.target.closest('[data-tasks]')) return vscode.postMessage({ type: 'tasks' });
    if (e.target.closest('[data-summon]')) return vscode.postMessage({ type: 'summon' });
    const grp = e.target.closest('[data-group]');
    if (grp) return vscode.postMessage({ type: 'group', i: +grp.dataset.group });
    if (e.target.closest('[data-graphify]')) return vscode.postMessage({ type: 'graphify' });
    const run = e.target.closest('[data-run]');
    if (run) { run.disabled = true; run.textContent = 'Starting…'; return vscode.postMessage({ type: 'run', id: run.dataset.run }); }
    const inst = e.target.closest('[data-install]');
    if (inst) return vscode.postMessage({ type: 'install', id: inst.dataset.install });
    const dg = e.target.closest('[data-dg]');
    if (dg) return vscode.postMessage({ type: 'diagramOpen', what: dg.dataset.dg });
    if (e.target.closest('img.diagram')) return vscode.postMessage({ type: 'diagramOpen', what: 'png' });
    const v = e.target.closest('button[data-v]');
    if (v) return vscode.postMessage({ type: 'verdict', verdict: v.dataset.v });
    if (e.target.closest('#send')) return vscode.postMessage({ type: 'send' });
    if (e.target.closest('#ask')) { const q = document.getElementById('q'); vscode.postMessage({ type: 'ask', q: q.value }); q.value = ''; }
  });
  document.querySelectorAll('[data-target]').forEach((c) => c.addEventListener('change', () => vscode.postMessage({ type: 'testOn', target: c.dataset.target, on: c.checked })));
  const timers = {};
  const later = (k, f) => { clearTimeout(timers[k]); timers[k] = setTimeout(f, 350); };
  const sendItem = (el) => {
    el.classList.toggle('off', !el.querySelector('.on').checked);
    vscode.postMessage({ type: 'plan', key: el.dataset.key, on: el.querySelector('.on').checked, action: el.querySelector('.act').value, note: el.querySelector('.note').value });
  };
  document.querySelectorAll('.item').forEach((el) => {
    el.querySelector('.on').addEventListener('change', () => sendItem(el));
    el.querySelector('.act').addEventListener('change', () => { el.querySelector('.on').checked = true; sendItem(el); });
    el.querySelector('.note').addEventListener('input', () => later(el.dataset.key, () => { el.querySelector('.on').checked = true; sendItem(el); }));
  });
  document.querySelectorAll('textarea.ctx').forEach((t) => t.addEventListener('input', () => later(t.dataset.k, () => vscode.postMessage({ type: 'ctx', k: t.dataset.k, text: t.value }))));
  window.addEventListener('message', ({ data }) => {
    if (data.type === 'count') document.getElementById('count').textContent = data.n;
  });
</script></body></html>`;
}

// --------------------------------------------------------------- activate

function rootsWithReview() {
  return (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath).filter((r) => fs.existsSync(path.join(r, REVIEW_FILE)));
}

/**
 * The agent half lives in a skill. Install it into Claude Code and Codex on first run, and keep it
 * current when the extension updates; a skill the user edited is left alone.
 */
function installSkill(context) {
  const src = path.join(context.extensionPath, "skill", "SKILL.md");
  if (!fs.existsSync(src)) return;
  const body = fs.readFileSync(src, "utf8");
  const hash = crypto.createHash("sha1").update(body).digest("hex");
  const done = [];
  for (const [agent, dir] of [["Claude Code", path.join(os.homedir(), ".claude", "skills", "review-handoff")], ["Codex", path.join(os.homedir(), ".codex", "skills", "review-handoff")]]) {
    const dst = path.join(dir, "SKILL.md");
    const key = `skillHash:${dst}`;
    const prev = context.globalState.get(key);
    let cur = null;
    try {
      cur = crypto.createHash("sha1").update(fs.readFileSync(dst, "utf8")).digest("hex");
    } catch {}
    if (cur === hash) continue;
    if (cur && prev && cur !== prev) continue; // edited by the user since we wrote it
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(dst, body);
      context.globalState.update(key, hash);
      done.push(agent);
    } catch {}
  }
  if (done.length)
    vscode.window.showInformationMessage(`Review Handoff: installed the review-handoff skill for ${done.join(" and ")}. Ask your agent for /review-handoff when a change is ready.`);
}

function activate(context) {
  extPath = context.extensionPath;
  installSkill(context);
  tasks.init({ claudeBin, openReview, context });
  ctrl = vscode.comments.createCommentController("reviewHandoff", "Review");
  ctrl.options = { prompt: "Comment for the agent", placeHolder: "Ask why, or ask for a change" };
  ctrl.commentingRangeProvider = {
    provideCommentingRanges(doc) {
      const rel = relOf(doc.uri);
      if (!rel || !current.review.files.some((f) => f.path === rel)) return [];
      return [new vscode.Range(0, 0, Math.max(0, doc.lineCount - 1), 0)];
    },
  };

  const seen = context.workspaceState;
  const markSeen = (root) => {
    try {
      const m = fs.statSync(path.join(root, REVIEW_FILE)).mtimeMs;
      const fresh = seen.get(`opened:${root}`) !== m;
      seen.update(`opened:${root}`, m);
      return fresh;
    } catch {
      return false;
    }
  };
  const maybeAutoOpen = (root) => {
    if (vscode.workspace.getConfiguration("reviewHandoff").get("autoOpen") && markSeen(root)) openReview(root);
  };

  const watcher = vscode.workspace.createFileSystemWatcher("**/.review/review.json");
  // Checks, test results and the diagram land while the review is open.
  const outputs = vscode.workspace.createFileSystemWatcher("**/{.review/checks/*.json,.review/diagram.png,graphify-out/graph.json}");
  const onOutput = async (uri) => {
    if (!current) return;
    if (uri && uri.fsPath.endsWith("graph.json")) await analyse();
    addCheckThreads();
    rerender();
  };
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.text = "$(tasklist) Tasks";
  status.tooltip = "Review Handoff: tasks board";
  status.command = "reviewHandoff.tasks";
  status.show();
  const onWrite = (uri) => maybeAutoOpen(path.dirname(path.dirname(uri.fsPath)));

  context.subscriptions.push(
    ctrl,
    watcher,
    outputs,
    status,
    outputs.onDidCreate(onOutput),
    outputs.onDidChange(onOutput),
    vscode.window.onDidCloseTerminal((t) => {
      for (const j of jobs.values()) if (j.terminal === t) j.closed = true;
      if ([...jobs.entries()].some(([k, j]) => k.startsWith("install:") && j.terminal === t)) detectPlugins();
      rerender();
    }),
    vscode.commands.registerCommand("reviewHandoff.tasks", () => tasks.open(context)),
    vscode.commands.registerCommand("reviewHandoff.openRoot", (root) => root && openReview(root, { force: true })),
    vscode.commands.registerCommand("reviewHandoff.installSkill", () => {
      for (const k of context.globalState.keys()) if (k.startsWith("skillHash:")) context.globalState.update(k, undefined);
      installSkill(context);
    }),
    vscode.commands.registerCommand("reviewHandoff.summonSkill", () =>
      skills.summon(context, { cwd: current?.root || (vscode.workspace.workspaceFolders || [])[0]?.uri.fsPath, claudeBin: claudeBin() })
    ),
    watcher.onDidCreate(onWrite),
    watcher.onDidChange(onWrite),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, baseProvider),
    vscode.window.onDidChangeTextEditorSelection(onSelection),
    vscode.commands.registerCommand("reviewHandoff.reply", onReply),
    vscode.commands.registerCommand("reviewHandoff.open", async () => {
      const roots = rootsWithReview();
      if (!roots.length) return vscode.window.showWarningMessage("Review Handoff: no .review/review.json in this workspace.");
      const root = roots.length === 1 ? roots[0] : await vscode.window.showQuickPick(roots);
      if (root) openReview(root, { force: true });
    }),
    vscode.window.registerUriHandler({
      handleUri(uri) {
        // vscode://local.review-handoff/open?root=/abs/repo
        const root = new URLSearchParams(uri.query).get("root");
        if (!root) return;
        markSeen(root);
        openReview(root, { force: true });
      },
    })
  );

  sidebar.create(context, { tasks, hasReview: (r) => fs.existsSync(path.join(r, REVIEW_FILE)) });
  for (const root of rootsWithReview()) maybeAutoOpen(root);
}

function deactivate() {}

module.exports = { activate, deactivate };
