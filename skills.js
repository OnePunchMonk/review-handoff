// Skill summoner: one searchable list of every skill the user has, sorted by use.
// Sources: ~/.claude/skills, <workspace>/.claude/skills, Claude Code plugins, ~/.codex/skills.
"use strict";
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

const HOME = process.env.HOME || "";

function frontmatter(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return null;
  const get = (k) => {
    const line = m[1].match(new RegExp(`^${k}:\\s*(.*)$`, "m"));
    if (!line) return "";
    let v = line[1].trim();
    if (/^[>|]-?$/.test(v)) {
      // folded block: following indented lines
      const rest = m[1].slice(m[1].indexOf(line[0]) + line[0].length).split("\n").slice(1);
      v = rest.filter((l, i) => /^\s+\S/.test(l) && rest.slice(0, i).every((p) => /^\s+\S/.test(p))).map((l) => l.trim()).join(" ");
    }
    return v.replace(/^["']|["']$/g, "");
  };
  return { name: get("name"), description: get("description"), userOnly: /^disable-model-invocation:\s*true/m.test(m[1]) };
}

/** Skill dirs one level under `dir`, each with a SKILL.md. */
function scanDir(dir, source, prefix) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const file = path.join(dir, e.name, "SKILL.md");
    const fm = fs.existsSync(file) && frontmatter(file);
    if (!fm) continue;
    const name = fm.name || e.name;
    out.push({ id: prefix ? `${prefix}:${name}` : name, name, description: fm.description, source, file, userOnly: fm.userOnly });
  }
  return out;
}

/** Plugin skills live at <plugin root>/skills/<name>/SKILL.md; the plugin name comes from .claude-plugin/plugin.json. */
function scanPlugins(root, depth = 0, out = []) {
  if (depth > 6) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return out;
  }
  // A synced single-skill plugin keeps SKILL.md at its root.
  if (entries.some((e) => e.name === "SKILL.md") && entries.some((e) => e.name === ".claude-plugin")) {
    let plugin = path.basename(root);
    try {
      plugin = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8")).name || plugin;
    } catch {}
    const fm = frontmatter(path.join(root, "SKILL.md"));
    if (fm) out.push({ id: `${plugin}:${fm.name || plugin}`, name: fm.name || plugin, description: fm.description, source: `plugin ${plugin}`, file: path.join(root, "SKILL.md"), userOnly: fm.userOnly });
    return out;
  }
  if (entries.some((e) => e.name === "skills" && e.isDirectory())) {
    let plugin = path.basename(root);
    try {
      plugin = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin", "plugin.json"), "utf8")).name || plugin;
    } catch {}
    out.push(...scanDir(path.join(root, "skills"), `plugin ${plugin}`, plugin));
    return out;
  }
  for (const e of entries) if (e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules") scanPlugins(path.join(root, e.name), depth + 1, out);
  return out;
}

/** Only plugins that are installed (or synced from claude.ai), not every plugin in a marketplace catalogue. */
function installedPluginRoots() {
  const base = path.join(HOME, ".claude", "plugins");
  const out = [];
  try {
    const reg = JSON.parse(fs.readFileSync(path.join(base, "installed_plugins.json"), "utf8"));
    for (const list of Object.values(reg.plugins || {})) for (const e of list) if (e.installPath) out.push(e.installPath);
  } catch {}
  out.push(path.join(base, "synced"));
  return out;
}

function discover(roots) {
  const all = [
    ...scanDir(path.join(HOME, ".claude", "skills"), "personal"),
    ...roots.flatMap((r) => scanDir(path.join(r, ".claude", "skills"), `project ${path.basename(r)}`)),
    ...installedPluginRoots().flatMap((r) => scanPlugins(r)),
    ...scanDir(path.join(HOME, ".codex", "skills"), "codex").map((s) => ({ ...s, codex: true })),
  ];
  const seen = new Set();
  return all.filter((s) => (seen.has(s.id + s.source) ? false : seen.add(s.id + s.source)));
}

/** Installable plugins from every configured marketplace (the "skill store"), minus installed ones. */
function store() {
  const base = path.join(HOME, ".claude", "plugins");
  let known = {};
  let installed = {};
  try {
    known = JSON.parse(fs.readFileSync(path.join(base, "known_marketplaces.json"), "utf8"));
  } catch {}
  try {
    installed = JSON.parse(fs.readFileSync(path.join(base, "installed_plugins.json"), "utf8")).plugins || {};
  } catch {}
  const out = [];
  for (const [market, m] of Object.entries(known)) {
    try {
      const cat = JSON.parse(fs.readFileSync(path.join(m.installLocation, ".claude-plugin", "marketplace.json"), "utf8"));
      for (const p of cat.plugins || []) {
        const id = `${p.name}@${market}`;
        if (!installed[id]) out.push({ id, name: p.name, market, description: p.description || "", category: p.category || "" });
      }
    } catch {}
  }
  return out;
}

const firstSentence = (s) => (String(s || "").match(/^.*?[.!?](\s|$)/) || [s])[0].trim();

/**
 * QuickPick over all skills. Frequent and recent first; type to filter by name or description.
 * Then: run it in a fresh Claude terminal (with optional args), or copy "/name" for your own session.
 */
async function summon(context, { cwd, claudeBin, hint } = {}) {
  const roots = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
  const skills = discover(roots);
  if (!skills.length) return vscode.window.showWarningMessage("No skills found in ~/.claude/skills, the workspace, or plugins.");
  const usage = context.globalState.get("skillUsage", {});
  const score = (s) => {
    const u = usage[s.id];
    if (!u) return 0;
    const days = (Date.now() - u.last) / 864e5;
    return u.count / (1 + days / 7);
  };
  skills.sort((a, b) => score(b) - score(a) || a.id.localeCompare(b.id));
  const used = skills.filter((s) => usage[s.id]);
  const rest = skills.filter((s) => !usage[s.id]);
  const item = (s) => ({
    label: s.id,
    description: `${s.source}${s.userOnly ? " · you invoke it" : ""}${usage[s.id] ? ` · used ${usage[s.id].count}×` : ""}`,
    detail: firstSentence(s.description),
    skill: s,
  });
  const qp = vscode.window.createQuickPick();
  qp.title = "Summon a skill";
  qp.placeholder = hint || "Type what you want to do: 'review', 'diagram', 'benchmark', 'profile'...";
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  const shop = store();
  qp.items = [
    ...(used.length ? [{ label: "Recent and frequent", kind: vscode.QuickPickItemKind.Separator }, ...used.map(item)] : []),
    { label: `Installed skills (${skills.length})`, kind: vscode.QuickPickItemKind.Separator },
    ...rest.map(item),
    ...(shop.length
      ? [
          { label: `Store: installable plugins (${shop.length})`, kind: vscode.QuickPickItemKind.Separator },
          ...shop.map((p) => ({ label: `$(cloud-download) ${p.name}`, description: `${p.market}${p.category ? `, ${p.category}` : ""}`, detail: firstSentence(p.description), plugin: p })),
        ]
      : []),
  ];
  qp.buttons = [{ iconPath: new vscode.ThemeIcon("go-to-file"), tooltip: "Open the skill's SKILL.md" }];
  const picked = await new Promise((resolve) => {
    qp.onDidAccept(() => resolve(qp.selectedItems[0]));
    qp.onDidTriggerButton(() => {
      const s = qp.activeItems[0]?.skill;
      if (s) vscode.window.showTextDocument(vscode.Uri.file(s.file), { preview: true });
    });
    qp.onDidHide(() => resolve(undefined));
    qp.show();
  });
  qp.dispose();
  if (picked?.plugin) {
    const p = picked.plugin;
    const ok = await vscode.window.showInformationMessage(`Install the ${p.name} plugin?`, { modal: true, detail: `${p.description}\n\nRuns: claude plugin install ${p.id}\nIts skills appear in this list in new sessions.` }, "Install");
    if (ok !== "Install") return;
    const t = vscode.window.createTerminal({ name: `Install ${p.name}`, cwd });
    t.show();
    t.sendText(`'${claudeBin.replace(/'/g, `'\\''`)}' plugin install '${p.id}'`);
    return;
  }
  if (!picked?.skill) return;
  const s = picked.skill;

  const how = await vscode.window.showQuickPick(
    [
      { label: "$(terminal) Run in a new Claude session", description: "fresh context, in a terminal here", v: "run" },
      { label: "$(clippy) Copy for my session", description: s.codex ? `$${s.name}` : `/${s.id}`, v: "copy" },
      { label: "$(book) Read SKILL.md", v: "read" },
    ],
    { title: s.id, placeHolder: firstSentence(s.description) }
  );
  if (!how) return;
  if (how.v === "read") return vscode.window.showTextDocument(vscode.Uri.file(s.file), { preview: true });
  const args = await vscode.window.showInputBox({ title: `/${s.id}`, prompt: "Arguments or what you want (optional)", ignoreFocusOut: true });
  if (args === undefined) return;
  usage[s.id] = { count: (usage[s.id]?.count || 0) + 1, last: Date.now() };
  context.globalState.update("skillUsage", usage);
  const cmd = `${s.codex ? `$${s.name}` : `/${s.id}`}${args ? ` ${args}` : ""}`;
  if (how.v === "copy") {
    await vscode.env.clipboard.writeText(cmd);
    return vscode.window.showInformationMessage(`Copied "${cmd}". Paste it into your agent session.`);
  }
  const t = vscode.window.createTerminal({ name: `Skill · ${s.name}`, cwd });
  t.show();
  const q = (x) => `'${String(x).replace(/'/g, `'\\''`)}'`;
  t.sendText(s.codex ? `codex ${q(cmd)}` : `${q(claudeBin)} ${q(cmd)}`);
}

/** Compact list for prompts (the task organiser assigns skills to tasks). */
function catalog(roots) {
  return discover(roots)
    .filter((s) => !s.codex)
    .map((s) => `- ${s.id}: ${firstSentence(s.description).slice(0, 160)}`)
    .join("\n");
}

module.exports = { summon, discover, catalog, store };
