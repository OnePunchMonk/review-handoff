// Activity Bar home: the review in this workspace, the tasks running in parallel, and quick actions.
"use strict";
const vscode = require("vscode");
const fs = require("fs");
const path = require("path");

const STATUS_ICON = { "ready for review": "eye", "changes requested": "comment-discussion", working: "sync~spin", pushed: "check", approved: "check", waiting: "clock", "not started": "circle-outline", removed: "trash" };

function create(context, { tasks, hasReview }) {
  const emitter = new vscode.EventEmitter();
  const item = (label, opts = {}) => Object.assign(new vscode.TreeItem(label, opts.children ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None), opts);
  const provider = {
    onDidChangeTreeData: emitter.event,
    getTreeItem: (x) => x,
    getChildren(el) {
      const roots = (vscode.workspace.workspaceFolders || []).map((f) => f.uri.fsPath);
      if (!el) {
        const out = [];
        for (const r of roots.filter(hasReview)) {
          const rv = JSON.parse(fs.readFileSync(path.join(r, ".review", "review.json"), "utf8"));
          out.push(item(rv.title || path.basename(r), { description: "review", iconPath: new vscode.ThemeIcon("diff-multiple"), command: { command: "reviewHandoff.openRoot", title: "Open", arguments: [r] }, tooltip: "Open this review" }));
        }
        const store = roots.map((r) => path.join(r, ".review", "tasks.json")).find((f) => fs.existsSync(f));
        const list = store ? JSON.parse(fs.readFileSync(store, "utf8")).tasks || [] : [];
        out.push(item("Tasks", { children: list.length > 0, description: list.length ? `${list.length}` : "dump and organise", iconPath: new vscode.ThemeIcon("tasklist"), command: { command: "reviewHandoff.tasks", title: "Tasks" }, contextValue: "tasks", list }));
        out.push(item("Summon a skill", { iconPath: new vscode.ThemeIcon("sparkle"), description: "⌥⌘K", command: { command: "reviewHandoff.summonSkill", title: "Summon" } }));
        if (!roots.some(hasReview)) out.push(item("No review yet: ask your agent for /review-handoff", { iconPath: new vscode.ThemeIcon("info") }));
        return out;
      }
      if (el.list)
        return el.list.map((t) => {
          const st = tasks.status(t);
          const ready = ["ready for review", "changes requested", "approved", "pushed"].includes(st);
          return item(t.title, {
            description: st,
            iconPath: new vscode.ThemeIcon(STATUS_ICON[st] || "circle-outline"),
            command: ready ? { command: "reviewHandoff.openRoot", title: "Review", arguments: [t.dir] } : { command: "reviewHandoff.tasks", title: "Tasks" },
            tooltip: ready ? "Open its review" : "Open the Tasks board",
          });
        });
      return [];
    },
  };
  const view = vscode.window.createTreeView("reviewHandoff.home", { treeDataProvider: provider });
  const timer = setInterval(() => view.visible && emitter.fire(), 5000);
  context.subscriptions.push(view, { dispose: () => clearInterval(timer) });
  return { refresh: () => emitter.fire() };
}

module.exports = { create };
