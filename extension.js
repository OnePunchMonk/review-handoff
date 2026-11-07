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

/** Independent reviewers; the review-handoff skill defines what each job does. */
const REVIEWERS = { codex: { name: "Codex" }, goldfish: { name: "Goldfish" }, ponytail: { name: "Ponytail" } };
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
  if (j && j.root === current.root && j.running) return "running";
  if (j && j.root === current.root && j.error) return "failed";
  const file = id === "diagram" ? path.join(current.root, ".review", "diagram.png") : path.join(checksDir(), `${id}.json`);
  return fs.existsSync(file) ? "done" : "never";
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

/**
 * Tools each headless job may use, approved up front so it never stops to ask.
 * Reading is open; writing is limited to .review/.
 */
const READ_TOOLS = ["Read", "Grep", "Glob", "Skill", "Bash(git diff:*)", "Bash(git show:*)", "Bash(git log:*)", "Bash(git ls-files:*)", "Bash(ls:*)", "Bash(mv .review/:*)", "Edit(.review/**)"];
const JOB_TOOLS = {
  assess: [],
  diagram: ["Bash(cd:*)", "Bash(uv run python render_excalidraw.py:*)", "Bash(uv run --directory:*)"],
  codex: ["mcp__codex-cli__codex"],
  goldfish: ["Agent", "Task"],
  ponytail: ["Agent", "Task"],
};
const JOB_LABEL = { assess: "Reviewing", diagram: "Drawing", codex: "Codex reviewing", goldfish: "Goldfish reviewing", ponytail: "Ponytail reviewing", tests: "Testing on Modal" };

/** A clean environment: a job started from inside a Claude session must not inherit its markers. */
function jobEnv(extra) {
  const home = os.homedir();
  const env = { ...process.env, ...extra, PATH: [`${home}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin", process.env.PATH].join(":") };
  for (const k of Object.keys(env)) if (k.startsWith("CLAUDE_CODE_") || k === "CLAUDECODE") delete env[k];
  return env;
}

let jobStatus;
function updateJobStatus() {
  const running = [...jobs.entries()].filter(([, j]) => j.running);
  if (!jobStatus) return;
  if (!running.length) return jobStatus.hide();
  jobStatus.text = `$(sync~spin) ${running.map(([id]) => JOB_LABEL[id] || id).join(", ")}`;
  jobStatus.show();
}

/** Independent jobs run headless: no terminal, no prompts. The panel shows progress and the result. */
function runJob(id) {
  if (!current) return;
  const root = current.root;
  if (jobs.get(id)?.running) return;
  const logDir = path.join(root, ".review", "jobs");
  fs.mkdirSync(logDir, { recursive: true });
  const log = path.join(logDir, `${id}.log`);
  let cmd;
  let args;
  let env = jobEnv();
  if (id === "tests") {
    const last = readJson(path.join(checksDir(), "tests.json"));
    const tests = { ...(last?.targets ? { targets: last.targets } : {}), ...(current.review.tests || {}) };
    const targets = tests.targets || [];
    if (!targets.length) return vscode.window.showWarningMessage("Review Handoff: no test targets ticked.");
    cmd = modalBin();
    args = ["run", path.join(extPath, "modal_tests.py")];
    env = jobEnv({ REVIEW_ROOT: root, REVIEW_TESTS: JSON.stringify({ ...tests, targets }) });
  } else {
    const what = id === "diagram" || id === "assess" ? id : `review-${id}`;
    const prof = tasks.profile(cfg("jobProfile") || "claude-sonnet-medium");
    cmd = claudeBin();
    args = ["-p", `Use the review-handoff skill, job "${what}", for the review in ${root}. You are running headless: do not ask questions, and write only inside .review/.`,
      "--allowedTools", ...READ_TOOLS, ...(JOB_TOOLS[id] || [])];
    if (prof.cli === "claude") args.push("--model", prof.model, "--effort", prof.effort);
  }
  const out = fs.openSync(log, "w");
  const child = cp.spawn(cmd, args, { cwd: root, env, stdio: ["ignore", out, out] });
  const job = { root, started: Date.now(), running: true, child, log };
  jobs.set(id, job);
  child.on("error", (e) => {
    fs.appendFileSync(log, `\n${e.message}\n`);
  });
  child.on("close", (code) => {
    fs.closeSync(out);
    job.running = false;
    job.code = code;
    const produced = id === "diagram" ? path.join(root, ".review", "diagram.png") : path.join(root, ".review", "checks", `${id}.json`);
    const fresh = fs.existsSync(produced) && fs.statSync(produced).mtimeMs >= job.started;
    if (fresh && id === "diagram") vscode.commands.executeCommand("vscode.open", vscode.Uri.file(produced), { viewColumn: vscode.ViewColumn.One });
    if (!fresh && !job.cancelled) {
      const tail = (fs.readFileSync(log, "utf8").trim().split("\n").pop() || `exit ${code}`).slice(0, 200);
      job.error = tail;
    }
    updateJobStatus();
    if (current && current.root === root) {
      addCheckThreads();
      rerender();
    }
  });
  updateJobStatus();
  rerender();
}

function cancelJob(id) {
  const j = jobs.get(id);
  if (j?.running) {
    j.cancelled = true;
    j.child.kill("SIGTERM");
  }
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
  return { body: md(clip(body, NOTE_MAX) + (more ? "\n\n*More in the review panel.*" : "")), mode: vscode.CommentMode.Preview, author: { name: "Why" }, contextValue: "note" };
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
        else {
          const hasTests = (current.review.tests?.targets || readJson(path.join(checksDir(), "tests.json"))?.targets || []).length;
          for (const id of ["assess", "codex", "goldfish", "ponytail", "tests"]) {
            if (id === "ponytail" && plugins && !plugins.has("ponytail")) continue;
            if (id === "tests" && !hasTests) continue;
            if (jobState(id) !== "running") runJob(id);
          }
        }
      }
      if (msg.type === "cancel") (msg.id === "all" ? [...jobs.keys()] : [msg.id]).forEach(cancelJob);
      if (msg.type === "round") compareRound(msg.n);
      if (msg.type === "log") {
        const j = jobs.get(msg.id);
        if (j?.log) vscode.window.showTextDocument(vscode.Uri.file(j.log), { preview: true, viewColumn: vscode.ViewColumn.One });
      }
      if (msg.type === "ask") askQuestion(msg.q);
      if (msg.type === "switchTask") openReview(msg.root, { force: true });
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

/** One chip per task that has a review, so you can move between parallel tasks. */
/** Parallel tasks as chips, so you can move between their reviews; plus Tasks and Skills. */
function taskStrip() {
  const chips = tasks
    .strip(current.root)
    .map((t) => `<button class="chip ${t.root === current.root ? "on" : ""}" data-root="${esc(t.root)}" title="${esc(t.status)}">${esc(t.title)}</button>`)
    .join("");
  return `${chips}<button class="chip" data-tasks>Tasks</button><button class="chip" data-summon title="Summon a skill (⌥⌘K)">Skills</button>`;
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

// ---------------------------------------------------------------- history
//
// Each Send or Approve & push saves the round: what you reviewed (code snapshot via
// `git stash create`, kept alive by refs/review-handoff/round-N), the write-up, your
// feedback, checks and diagram. "Compare with now" shows what the agent did with it.

function historyDir() {
  return path.join(current.root, ".review", "history");
}

async function snapshotRound(fb, kind) {
  const root = current.root;
  const n = fb.round || 1;
  const dir = path.join(historyDir(), String(n));
  fs.mkdirSync(path.join(dir, "checks"), { recursive: true });
  const copy = (from, to) => {
    try {
      fs.copyFileSync(from, to);
    } catch {}
  };
  copy(path.join(root, REVIEW_FILE), path.join(dir, "review.json"));
  copy(feedbackPath(), path.join(dir, "feedback.json"));
  copy(path.join(root, ".review", "diagram.png"), path.join(dir, "diagram.png"));
  try {
    for (const f of fs.readdirSync(checksDir())) copy(path.join(checksDir(), f), path.join(dir, "checks", f));
  } catch {}
  const sha = ((await git(root, ["stash", "create"])) || "").trim() || ((await git(root, ["rev-parse", "HEAD"])) || "").trim();
  if (sha) await git(root, ["update-ref", `refs/review-handoff/round-${n}`, sha]);
  const a = readAssessment();
  const t = readJson(path.join(checksDir(), "tests.json"));
  fs.writeFileSync(
    path.join(dir, "meta.json"),
    JSON.stringify({ round: n, kind, at: new Date().toISOString(), sha, title: current.review.title, asked: (fb.todo || []).map((x) => x.text), concerns: a ? a.rows.filter((r) => r.verdict === "concern").length : null, tests: t && !t.running ? `${t.passed} passed${t.failed + t.errors ? `, ${t.failed + t.errors} failed` : ""}` : null, pushed: fb.pushed || null }, null, 2) + "\n"
  );
}

function rounds() {
  try {
    return fs
      .readdirSync(historyDir())
      .map((d) => readJson(path.join(historyDir(), d, "meta.json")))
      .filter(Boolean)
      .sort((a, b) => b.round - a.round);
  } catch {
    return [];
  }
}

async function compareRound(n) {
  const m = rounds().find((r) => r.round === n);
  if (!m?.sha) return;
  const names = ((await git(current.root, ["diff", "--name-only", m.sha])) || "").split("\n").map((x) => x.trim()).filter((x) => x && !x.startsWith(".review/"));
  if (!names.length) return vscode.window.showInformationMessage(`Nothing changed since round ${n}.`);
  const res = names.map((f) => {
    const abs = fileUri(f);
    return [abs, baseUri(current.root, m.sha, f), fs.existsSync(abs.fsPath) ? abs : undefined];
  });
  await vscode.commands.executeCommand("vscode.changes", `Round ${n} → now`, res);
}

function historyHtml(webview) {
  const rs = rounds();
  if (!rs.length) return `<p class="small">Each time you send feedback or approve, the round is saved here, so you can see what the agent did with it.</p>`;
  return `<ol class="hist">${rs
    .map((r) => {
      const png = path.join(historyDir(), String(r.round), "diagram.png");
      const asked = r.asked || [];
      return `<li><div class="h-h"><strong>Round ${r.round}</strong><span class="small">${esc(new Date(r.at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }))}</span><span class="sp"></span>${r.sha ? `<button class="ghost" data-round="${r.round}">Compare with now</button>` : ""}</div>
        <div class="small">${r.kind === "approve" ? `Approved${r.pushed ? ` and pushed ${esc(r.pushed.sha)}` : ""}.` : asked.length ? `You asked for ${asked.length} ${asked.length === 1 ? "thing" : "things"}:` : "Sent with nothing to change."}${r.tests ? ` Tests: ${esc(r.tests)}.` : ""}${r.concerns ? ` ${r.concerns} review ${r.concerns === 1 ? "concern" : "concerns"}.` : ""}</div>
        ${asked.length ? `<ul class="asked">${asked.slice(0, 6).map((x) => `<li>${inline(clip(String(x), 120))}</li>`).join("")}${asked.length > 6 ? `<li class="small">and ${asked.length - 6} more</li>` : ""}</ul>` : ""}
        ${fs.existsSync(png) ? `<details><summary>Diagram then</summary><img class="diagram" alt="Diagram from round ${r.round}" src="${webview.asWebviewUri(vscode.Uri.file(png))}"></details>` : ""}</li>`;
    })
    .join("")}</ol>`;
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
  saveFeedback((fb) => (fb.round = (fb.round || 0) + 1));
  await snapshotRound(loadFeedback(), "approve");
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
      todo = buildTodo(fb);
      fb.todo = todo;
      fb.verdict = todo.length ? "request-changes" : "approve";
      fb.remember = String(fb.context?.remember || "").split("\n").map((x) => x.trim()).filter(Boolean);
      fb.submittedAt = new Date().toISOString();
      fb.round = (fb.round || 0) + 1;
    });
    snapshotRound(loadFeedback(), "send");
    const prompt = `Review handoff ready: read ${feedbackPath()} and act on it (${todo.length} item${todo.length === 1 ? "" : "s"}).`;
    vscode.env.clipboard.writeText(prompt);
    vscode.window.showInformationMessage(`Sent ${todo.length} item(s). Prompt copied: paste it into your agent session.`);
    rerender();
  }
  if (msg.type === "stepVerdict") saveFeedback((fb) => ((fb.steps = fb.steps || {})[msg.key] = { v: msg.v, text: msg.text || "" }));
  if (msg.type === "assessSend") saveFeedback((fb) => ((fb.assessSend = fb.assessSend || {})[msg.id] = msg.on));
  if (msg.type === "step") {
    const n = steps().length;
    if (msg.to === "show") return openStep(loadFeedback().cursor || 0);
    if (msg.to === "finish") return panel?.webview.postMessage({ type: "scroll", id: "finish" });
    const i = Math.max(0, Math.min(n - 1, +msg.to));
    saveFeedback((fb) => (fb.cursor = i));
    openStep(i);
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

// ------------------------------------------------------------ review screen
//
// One screen, one job: get from "the agent says it's done" to "I understand it and
// approved or corrected it". Top to bottom:
//   summary · map of the change (each box is a step) · the current step with its why
//   and only the concerns that sit in its code · finish (Send or Approve & push).
// Long-form detail, the PR conversation and past rounds are folded away at the end.

const LEAD_WORDS = 70;
const words = (s) => String(s || "").split(/\s+/).filter(Boolean).length;
const when = (ms) => new Date(ms).toTimeString().slice(0, 5);

const QUESTIONS = [
  ["why", "Why this change"],
  ["approach", "Why this way"],
  ["arch", "Architecture impact"],
  ["simpler", "Could it be simpler"],
  ["reuse", "Reuses existing code"],
  ["dead", "Dead code"],
  ["tests_missing", "Tests missing"],
  ["tests_reuse", "Existing tests to extend"],
  ["tests_worth", "Tests worth adding"],
  ["scale", "Scale"],
  ["maintain", "Maintenance"],
];

function readAssessment() {
  const a = readCheck("assess");
  if (!a) return null;
  const byId = new Map((a.questions || []).map((q) => [q.id, q]));
  a.rows = QUESTIONS.map(([id, label]) => ({ id, label, verdict: "unknown", answer: "Not answered.", ...byId.get(id) }));
  return a;
}

function steps() {
  return (current.analysis?.groups || []).map((g) => {
    const note = current.review.notes.find((n) => `note:${n.id}` === g.key);
    return { key: g.key, title: g.title, why: note?.body || "", detail: note?.detail || "", files: g.files, hunks: g.hunks, group: g, unexplained: g.hunks.filter((h) => !h.explained && !h.note).length };
  });
}

/** Show one step's code: a single file opens at the first change, several open together. */
async function openStep(i) {
  const s = steps()[i];
  if (!s) return;
  if (s.files.length === 1) return openFile(s.files[0], s.hunks[0].start);
  await vscode.commands.executeCommand("vscode.changes", `Step ${i + 1}: ${s.title}`, groupResources(s.group));
}

/** Every concern, placed on the step whose code it is about; the rest are global. */
function placeConcerns(fb, st) {
  const hit = (file, line) =>
    file ? st.findIndex((s) => s.hunks.some((h) => h.file === file && (!line || (line >= h.start - 3 && line <= h.end + 3)))) : -1;
  const per = st.map(() => []);
  const global = [];
  const put = (i, c) => (i >= 0 ? per[i] : global).push(c);
  const send = fb.assessSend || {};
  for (const r of readAssessment()?.rows || []) {
    if (r.verdict !== "concern") continue;
    const ref = (r.refs || [])[0] || "";
    const [file, line] = [ref.split(":")[0], +ref.split(":")[1] || 0];
    put(hit(file, line), { q: r.id, label: r.label, text: r.answer, detail: r.detail, on: send[r.id] !== false, hot: true });
  }
  for (const it of buildItems(fb)) {
    if (!["pr", "check", "you"].includes(it.kind)) continue;
    if (it.kind === "pr" && it.status !== "open" && !it.checked) continue;
    if (it.kind === "check" && it.sev === "nit" && !it.checked) continue;
    put(hit(it.file, it.line), { key: it.key, label: it.label, text: it.text, on: it.checked, hot: it.sev === "must" || it.status === "open" });
  }
  return { per, global };
}

function concernHtml(c) {
  const attr = c.q ? `data-q="${esc(c.q)}"` : `data-key="${esc(c.key)}"`;
  return `<label class="concern ${c.on ? "" : "off"}"><input type="checkbox" ${attr} ${c.on ? "checked" : ""} aria-label="send to the agent">
    <span><span class="clabel ${c.hot ? "hot" : ""}">${esc(c.label)}</span> ${inline(clip(String(c.text).replace(/\n+/g, " "), 160))}${c.detail ? `<span class="cdetail">${inline(clip(String(c.detail), 240))}</span>` : ""}</span></label>`;
}

/** The map: every step as a box in reading order. It shows progress and where concerns are; click to go there. */
function mapHtml(st, cur, verdicts, per) {
  return `<ol class="map" aria-label="Steps of the change">${st
    .map((s, i) => {
      const v = verdicts[s.key]?.v;
      const c = per[i].length;
      const state = v === "ok" ? "looks good" : v === "change" ? "needs change" : v === "question" ? "question" : c ? `${c} ${c === 1 ? "concern" : "concerns"}` : `${s.files.length} ${s.files.length === 1 ? "file" : "files"}`;
      return `<li><button class="node ${v || ""} ${i === cur ? "cur" : ""} ${c && !v ? "warn" : ""}" data-step="${i}" ${i === cur ? 'aria-current="step"' : ""}>
        <span class="n">${i + 1}</span><span class="t">${esc(s.title)}</span><span class="s">${esc(state)}</span></button></li>`;
    })
    .join("")}</ol>`;
}

/** One line for all checks, with one button. */
function checksLine() {
  const ids = ["assess", ...Object.keys(REVIEWERS), "tests"];
  const running = ids.filter((id) => jobState(id) === "running");
  const failed = ids.filter((id) => jobState(id) === "failed");
  const name = { assess: "review", codex: "Codex", goldfish: "Goldfish", ponytail: "Ponytail", tests: "tests" };
  const parts = [];
  const a = readAssessment();
  if (a) {
    const n = a.rows.filter((r) => r.verdict === "concern").length;
    parts.push(`review: ${n ? `${n} ${n === 1 ? "concern" : "concerns"}` : "no concerns"}`);
  }
  for (const id of Object.keys(REVIEWERS)) {
    const c = readCheck(id);
    if (c) parts.push(`${name[id]}: ${c.findings.length ? `${c.findings.length} ${c.findings.length === 1 ? "finding" : "findings"}` : "clean"}`);
  }
  const t = readJson(path.join(checksDir(), "tests.json"));
  if (t && !t.running) parts.push(`tests: ${t.passed} passed${t.failed + t.errors ? `, ${t.failed + t.errors} failed` : ""}`);
  const since = Math.min(...running.map((id) => jobs.get(id).started));
  const btn = running.length
    ? `<span class="small"><span class="spin" aria-hidden="true"></span>Checking (${running.map((id) => name[id]).join(", ")}) <span class="elapsed" data-since="${since}"></span></span><button class="ghost" data-cancel="all">Cancel</button>`
    : `<button class="${parts.length ? "ghost" : "primary"}" data-run="all">${parts.length ? "Re-run checks" : "Run checks"}</button>`;
  const err = failed.map((id) => `<span class="jerr" role="alert">${name[id]} failed. <a data-log="${id}">Log</a></span>`).join(" ");
  return `<div class="checks"><span class="small">${parts.length ? esc(parts.join(", ")) : "Checks find reuse, dead code, missing tests and bugs, and run your tests."}</span><span class="sp"></span>${btn}</div>${err ? `<div>${err}</div>` : ""}`;
}

function detailsHtml(review, fb) {
  const [, ...rest] = review.sections;
  const sec = [...rest, ...(review.deepDive || [])].map((s) => `<h4>${esc(s.heading)}</h4>${mdHtml(s.body)}`).join("");
  const answered = new Set((review.qa || []).map((x) => x.q.trim()));
  const pending = (fb.questions || []).filter((x) => !answered.has(x.q.trim()));
  const qa = [
    ...(review.qa || []).map((x) => `<div class="qa"><div class="q">${inline(x.q)}</div>${mdHtml(x.a)}</div>`),
    ...pending.map((x) => `<div class="qa"><div class="q">${inline(x.q)}</div><p class="small">Waiting for the agent.</p></div>`),
  ].join("");
  const an = current.analysis;
  const gen = review.files.filter((f) => f.generated);
  const unlisted = review.files.filter((f) => f.unlisted && !f.generated);
  return `${sec}
    ${unlisted.length ? `<h4>Changed but not mentioned by the agent</h4><p>${unlisted.map((f) => `<a class="ref" data-file="${esc(f.path)}" data-line="1">${esc(f.path)}</a>`).join(", ")}</p>` : ""}
    ${gen.length ? `<h4>Data and generated files, left out of the diff</h4><p class="small">${gen.map((f) => `<a class="ref" data-file="${esc(f.path)}" data-line="1">${esc(path.basename(f.path))}</a>`).join(", ")}</p>` : ""}
    <h4>Ask about this change</h4>${qa}
    <textarea id="q" aria-label="Your question" placeholder="Goes to your agent session, which has the context."></textarea>
    <div class="row"><button id="ask">Ask</button></div>
    ${prHtml()}
    <h4>More</h4><p class="small"><a data-run="diagram">Export a diagram (Excalidraw)</a>${an && !an.graph ? ` · <a data-graphify>Sharpen the map with Graphify</a>` : ""}</p>`;
}

function renderHtml() {
  const { review } = current;
  const fb = loadFeedback();
  const webview = panel.webview;
  webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.file(path.join(current.root, ".review"))] };
  const nonce = crypto.randomBytes(16).toString("hex");

  const [first] = review.sections;
  const lead = first ? (words(first.body) > LEAD_WORDS ? first.body.split(/\s+/).slice(0, LEAD_WORDS).join(" ") + " …" : first.body) : "";
  const st = steps();
  const verdicts = fb.steps || {};
  const cur = Math.min(Math.max(0, fb.cursor || 0), Math.max(0, st.length - 1));
  const { per, global } = placeConcerns(fb, st);
  const done = st.filter((s) => verdicts[s.key]?.v).length;
  const s = st[cur];
  const v = s ? verdicts[s.key] || {} : {};

  const step = s
    ? `<article class="step" aria-live="polite">
        <div class="step-h"><span class="small">Step ${cur + 1} of ${st.length}</span><span class="sp"></span><span class="small">${done} of ${st.length} reviewed</span></div>
        <h2>${inline(s.title)}</h2>
        ${s.why ? mdHtml(s.why) : `<p class="small">No explanation from the agent for this part.</p>`}
        <p class="files">${s.files.map((f) => `<a class="ref" data-file="${esc(f)}" data-line="${s.hunks.find((h) => h.file === f).start}">${esc(path.basename(f))}</a>`).join(", ")}${s.unexplained ? ` <span class="warnc">${s.unexplained} unexplained ${s.unexplained === 1 ? "part" : "parts"}</span>` : ""}</p>
        ${per[cur].length ? `<div class="concerns">${per[cur].map(concernHtml).join("")}</div>` : ""}
        ${s.detail ? `<details><summary>More</summary>${mdHtml(s.detail)}</details>` : ""}
        <div class="verdict" role="group" aria-label="Your verdict">
          <button class="v ${v.v === "ok" ? "on" : ""}" data-v2="ok" title="g">Looks good</button>
          <button class="v ${v.v === "change" ? "on" : ""}" data-v2="change" title="c">Needs change</button>
          <button class="v ${v.v === "question" ? "on" : ""}" data-v2="question" title="q">Question</button>
          <span class="sp"></span>
          <button class="ghost" data-step="${cur - 1}" ${cur ? "" : "disabled"} title="k">Back</button>
          <button class="primary" data-step="${cur + 1 < st.length ? cur + 1 : "finish"}" title="j">${cur + 1 < st.length ? "Next" : "Finish"}</button>
        </div>
        <textarea id="vtext" class="${v.v && v.v !== "ok" ? "" : "hidden"}" aria-label="Your note" placeholder="${v.v === "question" ? "What do you want to know?" : "What should change?"}">${esc(v.text || "")}</textarea>
      </article>`
    : `<p class="small">No code changes against ${esc(review.base)}.</p>`;

  const todoN = buildTodo(fb).length;
  const ctx = fb.context || {};
  const rs = rounds();
  const finish = `<section id="finish">
    ${global.length ? `<div class="concerns">${global.map(concernHtml).join("")}</div>` : ""}
    <textarea class="ctx" data-k="instructions" aria-label="Anything else for the agent" placeholder="Anything else for the agent?">${esc(ctx.instructions || "")}</textarea>
    <div class="row">${todoN ? `<button class="primary" id="send">Send ${todoN} to agent</button>` : ""}<button class="${todoN ? "" : "primary"}" data-v="approve" title="Commit the reviewed files and push this branch (asks first)">Approve &amp; push</button>
      <span class="sp"></span><span class="small">${fb.pushed ? `Pushed ${esc(fb.pushed.sha)}.` : fb.submittedAt ? `Sent ${esc(fb.submittedAt.slice(11, 16))}.` : ""}</span></div>
    <details class="mem"><summary>Remember for next time</summary><textarea class="ctx" data-k="remember" aria-label="Remember for next time" placeholder="One per line. Saved to the agent's memory.">${esc(ctx.remember || "")}</textarea></details>
  </section>`;

  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource}; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>
  body { font-family: var(--vscode-font-family); font-size: 13px; color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 0 18px 40px; line-height: 1.5; max-width: 760px; }
  h1 { font-size: 15px; margin: 0; } h2 { font-size: 14px; margin: 2px 0 4px; } h4 { font-size: 12px; margin: 14px 0 4px; }
  p, ul, ol { margin: 4px 0; } ul, ol { padding-left: 18px; }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; } a:hover { text-decoration: underline; }
  code { font-family: var(--vscode-editor-font-family); font-size: 12px; background: var(--vscode-textCodeBlock-background); padding: 0 3px; border-radius: 4px; }
  pre { background: var(--vscode-textCodeBlock-background); padding: 6px 8px; border-radius: 4px; font-size: 12px; white-space: pre-wrap; } pre code { background: none; padding: 0; }
  table { border-collapse: collapse; font-size: 12px; margin: 6px 0; } th, td { border: 1px solid var(--vscode-panel-border); padding: 2px 6px; text-align: left; }
  .small { font-size: 12px; color: var(--vscode-descriptionForeground); }
  .sp { flex: 1; }
  .top { display: flex; align-items: center; gap: 8px; padding: 12px 0 2px; }
  .chip { font-size: 11px; padding: 2px 9px; border-radius: 999px; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .chip.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .lead { margin: 6px 0 10px; color: var(--vscode-foreground); }
  button { font: inherit; font-size: 12px; border: 0; border-radius: 4px; padding: 4px 12px; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); white-space: nowrap; }
  button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  button.ghost { background: none; color: var(--vscode-textLink-foreground); padding: 4px 6px; }
  button:disabled { opacity: .45; cursor: default; }
  button:active:not(:disabled) { transform: translateY(1px); }
  :focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }
  textarea { width: 100%; box-sizing: border-box; min-height: 46px; margin-top: 8px; padding: 6px 8px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); border-radius: 4px; font: inherit; resize: vertical; }
  .hidden { display: none !important; }
  .row { display: flex; gap: 6px; align-items: center; margin-top: 8px; }
  .map { list-style: none; padding: 0; margin: 4px 0 6px; display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 6px; }
  .node { width: 100%; height: 100%; text-align: left; display: grid; grid-template-columns: 18px 1fr; grid-template-rows: auto auto; column-gap: 4px; padding: 6px 8px 6px 7px; white-space: normal; border-radius: 4px; border: 1px solid var(--vscode-panel-border); border-left: 3px solid transparent; background: var(--vscode-editorWidget-background, transparent); color: var(--vscode-foreground); }
  .node:hover { border-color: var(--vscode-descriptionForeground); }
  .node.cur { border-color: var(--vscode-focusBorder); box-shadow: inset 0 0 0 1px var(--vscode-focusBorder); }
  .node .n { grid-row: span 2; font-size: 11px; color: var(--vscode-descriptionForeground); padding-top: 1px; }
  .node .t { font-size: 12px; font-weight: 600; line-height: 1.3; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .node .s { font-size: 11px; color: var(--vscode-descriptionForeground); }
  .node.ok { border-left-color: var(--vscode-testing-iconPassed, #3fb950); } .node.ok .s { color: var(--vscode-testing-iconPassed, #3fb950); }
  .node.change, .node.question, .node.warn { border-left-color: var(--vscode-editorWarning-foreground); }
  .node.change .s, .node.question .s, .node.warn .s { color: var(--vscode-editorWarning-foreground); }
  .checks { display: flex; align-items: center; gap: 8px; margin: 4px 0 12px; min-height: 26px; }
  .spin { display: inline-block; width: 9px; height: 9px; margin-right: 6px; border: 1.5px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: rot .8s linear infinite; vertical-align: -1px; }
  @keyframes rot { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spin { animation: none; } button:active:not(:disabled) { transform: none; } }
  .jerr { font-size: 12px; color: var(--vscode-errorForeground); margin-right: 8px; }
  .step { border: 1px solid var(--vscode-panel-border); border-radius: 4px; padding: 10px 14px 12px; }
  .step-h { display: flex; }
  .files { font-size: 12px; margin-top: 6px; }
  .warnc { color: var(--vscode-editorWarning-foreground); font-size: 12px; }
  .concerns { margin: 8px 0 4px; display: flex; flex-direction: column; gap: 4px; }
  .concern { display: flex; gap: 8px; align-items: flex-start; font-size: 12px; padding: 6px 8px; border-radius: 4px; background: var(--vscode-textBlockQuote-background); }
  .concern.off { opacity: .55; } .concern input { margin-top: 2px; }
  .clabel { font-weight: 600; } .clabel.hot { color: var(--vscode-editorWarning-foreground); }
  .cdetail { display: block; color: var(--vscode-descriptionForeground); margin-top: 2px; }
  .verdict { display: flex; gap: 6px; align-items: center; margin-top: 10px; flex-wrap: wrap; }
  .verdict .v.on { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  #finish { margin-top: 18px; padding-top: 10px; border-top: 1px solid var(--vscode-panel-border); }
  details { margin-top: 6px; } summary { cursor: pointer; font-size: 12px; color: var(--vscode-descriptionForeground); }
  details.fold { border-top: 1px solid var(--vscode-panel-border); padding-top: 8px; margin-top: 14px; }
  details.fold > summary { font-size: 12px; font-weight: 600; color: var(--vscode-foreground); }
  .qa { border-left: 2px solid var(--vscode-focusBorder); padding: 2px 8px; margin: 6px 0; } .q { font-weight: 600; }
  .disc { border-top: 1px solid var(--vscode-panel-border); padding: 4px 0; font-size: 12px; } .who { font-weight: 600; }
  .hist { list-style: none; padding: 0; } .hist > li { padding: 6px 0; border-bottom: 1px solid var(--vscode-panel-border); }
  .h-h { display: flex; align-items: baseline; gap: 10px; } .asked { margin: 2px 0; font-size: 12px; }
  img.diagram { max-width: 100%; border-radius: 4px; background: #fff; }
</style></head><body>
<div class="top"><h1>${esc(review.title || "Review")}</h1><span class="sp"></span>${taskStrip()}</div>
${lead ? `<div class="lead">${mdHtml(lead)}</div>` : ""}
${st.length ? mapHtml(st, cur, verdicts, per) : ""}
${checksLine()}
${step}
${finish}
<details class="fold"><summary>Details</summary>${detailsHtml(review, fb)}</details>
${rs.length ? `<details class="fold"><summary>History (${rs.length} ${rs.length === 1 ? "round" : "rounds"})</summary>${historyHtml(webview)}</details>` : ""}
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const STEP_KEY = ${JSON.stringify(s ? s.key : "")};
  const post = (m) => vscode.postMessage(m);
  const state = vscode.getState() || {};
  window.scrollTo(0, state.scroll || 0);
  addEventListener('scroll', () => vscode.setState({ ...vscode.getState(), scroll: scrollY }), { passive: true });
  const tick = () => document.querySelectorAll('.elapsed').forEach((el) => { const s = Math.floor((Date.now() - +el.dataset.since) / 1000); el.textContent = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); });
  tick(); setInterval(tick, 1000);
  document.addEventListener('click', (e) => {
    const t = e.target;
    const ext = t.closest('a.ext'); if (ext) return post({ type: 'external', url: ext.dataset.url });
    if (t.closest('#refresh-pr')) return post({ type: 'refreshPr' });
    const ref = t.closest('a.ref'); if (ref) return post({ type: 'open', file: ref.dataset.file, line: +ref.dataset.line });
    const task = t.closest('[data-root]'); if (task) return post({ type: 'switchTask', root: task.dataset.root });
    if (t.closest('[data-tasks]')) return post({ type: 'tasks' });
    if (t.closest('[data-summon]')) return post({ type: 'summon' });
    if (t.closest('[data-graphify]')) return post({ type: 'graphify' });
    const rnd = t.closest('[data-round]'); if (rnd) return post({ type: 'round', n: +rnd.dataset.round });
    const cancel = t.closest('[data-cancel]'); if (cancel) return post({ type: 'cancel', id: cancel.dataset.cancel });
    const lg = t.closest('[data-log]'); if (lg) return post({ type: 'log', id: lg.dataset.log });
    const run = t.closest('[data-run]'); if (run) { if (run.tagName === 'BUTTON') { run.disabled = true; run.textContent = 'Starting…'; } return post({ type: 'run', id: run.dataset.run }); }
    const v2 = t.closest('[data-v2]');
    if (v2) {
      const box = document.getElementById('vtext');
      document.querySelectorAll('[data-v2]').forEach((b) => b.classList.toggle('on', b === v2));
      box.classList.toggle('hidden', v2.dataset.v2 === 'ok');
      box.placeholder = v2.dataset.v2 === 'question' ? 'What do you want to know?' : 'What should change?';
      if (v2.dataset.v2 !== 'ok') box.focus();
      return post({ type: 'stepVerdict', key: STEP_KEY, v: v2.dataset.v2, text: box.value });
    }
    const stp = t.closest('[data-step]'); if (stp && !stp.disabled) return post({ type: 'step', to: stp.dataset.step });
    if (t.closest('button[data-v]')) return post({ type: 'verdict', verdict: 'approve' });
    if (t.closest('#send')) return post({ type: 'send' });
    if (t.closest('#ask')) { const q = document.getElementById('q'); post({ type: 'ask', q: q.value }); q.value = ''; }
  });
  const timers = {};
  const later = (k, f) => { clearTimeout(timers[k]); timers[k] = setTimeout(f, 350); };
  const vt = document.getElementById('vtext');
  if (vt) vt.addEventListener('input', () => later('vtext', () => { const on = document.querySelector('[data-v2].on'); post({ type: 'stepVerdict', key: STEP_KEY, v: on ? on.dataset.v2 : 'change', text: vt.value }); }));
  document.querySelectorAll('.concern input').forEach((c) => c.addEventListener('change', () => {
    c.closest('.concern').classList.toggle('off', !c.checked);
    if (c.dataset.q) post({ type: 'assessSend', id: c.dataset.q, on: c.checked });
    else post({ type: 'plan', key: c.dataset.key, on: c.checked, action: 'fix', note: '' });
  }));
  document.querySelectorAll('textarea.ctx').forEach((t) => t.addEventListener('input', () => later(t.dataset.k, () => post({ type: 'ctx', k: t.dataset.k, text: t.value }))));
  document.addEventListener('keydown', (e) => {
    if (e.target.closest('textarea, input, select') || e.metaKey || e.ctrlKey || e.altKey) return;
    const sel = { j: '.verdict .primary', k: '.verdict .ghost[data-step]', g: '[data-v2="ok"]', c: '[data-v2="change"]', q: '[data-v2="question"]' }[e.key];
    if (sel) { e.preventDefault(); document.querySelector(sel)?.click(); }
  });
  window.addEventListener('message', ({ data }) => { if (data.type === 'scroll') document.getElementById(data.id)?.scrollIntoView({ behavior: 'smooth' }); });
</script></body></html>`;
}

/** Everything the user flagged, as the agent's to-do list. */
function buildTodo(fb) {
  const todo = [];
  const verdicts = fb.steps || {};
  for (const s of steps()) {
    const v = verdicts[s.key];
    if (!v || !["change", "question"].includes(v.v)) continue;
    todo.push({ key: `step:${s.key}`, kind: "step", from: "you", file: s.files[0], line: s.hunks[0].start, files: s.files, text: `${s.title}${v.text ? `: ${v.text}` : ""}`, action: v.v === "change" ? "change" : "answer", note: v.text || "" });
  }
  const a = readAssessment();
  const send = fb.assessSend || {};
  for (const r of a?.rows || [])
    if (r.verdict === "concern" && send[r.id] !== false)
      todo.push({ key: `assess:${r.id}`, kind: "review", from: "review", file: (r.refs || [])[0]?.split(":")[0], line: +((r.refs || [])[0]?.split(":")[1] || 0), text: `${r.label}: ${r.answer}`, action: "fix", note: r.detail || "" });
  for (const i of buildItems(fb))
    if ((i.kind === "pr" || i.kind === "check" || i.kind === "you") && i.checked)
      todo.push({ key: i.key, kind: i.kind, from: i.label, status: i.status, file: i.file, line: i.line, text: i.text, url: i.url, action: i.action === "skip" ? "fix" : i.action, note: i.note });
  return todo;
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
  jobStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  context.subscriptions.push(jobStatus, { dispose: () => jobs.forEach((j) => j.running && j.child.kill()) });
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
