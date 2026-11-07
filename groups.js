// Change groups: agents change many files in one sweep, and a file-by-file diff hides
// which edits belong together. Group changed hunks into logical changes:
//   * hunks under the same "why" note,
//   * hunks touching the same symbol, or a symbol another hunk defines or edits,
//   * with Graphify's graph (graphify-out/graph.json), hunks whose code is linked
//     by calls / imports / inherits edges.
// Also reports hunks that no note explains.
"use strict";
const fs = require("fs");
const path = require("path");

const KEYWORDS = new Set(
  "self this return import from const let var function class def async await None True False null true false undefined if else elif for while with try except finally raise throw new type interface public private static void string number bool boolean int float list dict tuple print assert yield lambda pass break continue export default require module".split(" ")
);
const DEF_RE = /^\s*(?:export\s+)?(?:async\s+)?(?:def|class|function|interface|type|struct|enum|fn|func)\s+([A-Za-z_]\w*)|^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*(?:async\s*)?(?:\(|function)/;

/** Parse `git diff -U0` into hunks with their new-side range and changed text. */
function parseDiff(text) {
  const hunks = [];
  let file = null;
  let h = null;
  for (const line of String(text || "").split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line.slice(4).replace(/^b\//, "");
      if (file === "/dev/null") file = null;
      continue;
    }
    const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@(.*)$/);
    if (m && file) {
      const start = Math.max(1, +m[1]);
      const n = m[2] === undefined ? 1 : +m[2];
      h = { file, start, end: Math.max(start, start + n - 1), added: 0, removed: 0, text: [], context: m[3] || "" };
      hunks.push(h);
      continue;
    }
    if (h && (line.startsWith("+") || line.startsWith("-")) && !line.startsWith("+++") && !line.startsWith("---")) {
      line[0] === "+" ? h.added++ : h.removed++;
      h.text.push(line.slice(1));
    }
  }
  return hunks;
}

/** A whole new file is one hunk; split big added hunks at top-level definitions so they can be grouped. */
function splitLarge(hunks, linesOf) {
  const out = [];
  for (const h of hunks) {
    const lines = linesOf(h.file);
    if (!lines || h.removed || h.end - h.start < 60) {
      out.push(h);
      continue;
    }
    const cuts = [];
    for (let i = h.start - 1; i < h.end; i++) {
      const l = lines[i] || "";
      const md = /\.(md|mdx|rst|txt)$/i.test(h.file);
      if (/^\S/.test(l) && (md ? /^#{1,3} /.test(l) : DEF_RE.test(l) || /^@/.test(l))) {
        if (/^@/.test(l) || !/^@/.test(lines[i - 1] || "")) cuts.push(i + 1); // decorator starts the block
      }
    }
    // Merge blocks under 6 lines into the one before, so constants and imports don't become groups.
    const starts = [];
    for (const c of [h.start, ...cuts.filter((c) => c > h.start)].sort((x, y) => x - y)) {
      if (!starts.length || c - starts[starts.length - 1] >= 6) starts.push(c);
    }
    starts.forEach((st, k) => {
      const en = k + 1 < starts.length ? starts[k + 1] - 1 : h.end;
      const text = lines.slice(st - 1, en);
      out.push({ file: h.file, start: st, end: en, added: text.length, removed: 0, text, context: "" });
    });
  }
  return out;
}

function words(lines) {
  const out = new Set();
  for (const l of lines) for (const w of l.match(/[A-Za-z_][A-Za-z0-9_]{3,}/g) || []) if (!KEYWORDS.has(w)) out.add(w);
  return out;
}

/** Symbols a hunk defines or edits: definitions inside it, plus the enclosing one. */
function ownSymbols(h, fileLines) {
  const own = new Set();
  for (const l of h.text) {
    const m = l.match(DEF_RE);
    if (m) own.add(m[1] || m[2]);
  }
  const hdr = h.context.match(/(?:def|class|function|fn|func)\s+([A-Za-z_]\w*)/);
  if (hdr) own.add(hdr[1]);
  if (fileLines) {
    const indent = (s) => s.match(/^\s*/)[0].length;
    const at = fileLines[h.start - 1] || "";
    for (let i = h.start - 1; i >= 0; i--) {
      const m = (fileLines[i] || "").match(DEF_RE);
      if (m && indent(fileLines[i]) <= indent(at)) {
        own.add(m[1] || m[2]);
        break;
      }
    }
  }
  return own;
}

function loadGraph(root) {
  for (const p of ["graphify-out/graph.json", ".review/graph.json"]) {
    try {
      const g = JSON.parse(fs.readFileSync(path.join(root, p), "utf8"));
      if (Array.isArray(g.nodes) && Array.isArray(g.links)) return { g, file: p };
    } catch {}
  }
  return null;
}

/**
 * hunks: from parseDiff (plus whole-file hunks for new files)
 * notes: review.notes; root: repo root
 * returns { groups: [{title, why, hunks, files}], unexplained: [hunk], graph: "graphify"|null }
 */
function group(root, hunks, notes) {
  hunks = hunks.slice();
  const fileCache = new Map();
  const linesOf = (f) => {
    if (!fileCache.has(f)) {
      try {
        fileCache.set(f, fs.readFileSync(path.join(root, f), "utf8").split("\n"));
      } catch {
        fileCache.set(f, null);
      }
    }
    return fileCache.get(f);
  };
  hunks = splitLarge(hunks, linesOf);
  hunks.forEach((h, i) => {
    h.i = i;
    h.own = ownSymbols(h, linesOf(h.file));
    h.uses = words(h.text);
    // The note that overlaps this hunk most (1 line of slack for small drift).
    let best = null;
    let bestOv = -1;
    for (const n of notes) {
      if (n.file !== h.file) continue;
      const ov = Math.min(h.end, (n.end || n.start) + 1) - Math.max(h.start, n.start - 1);
      if (ov >= 0 && ov > bestOv) (best = n), (bestOv = ov);
    }
    h.note = best;
  });

  // Weighted links between hunks; each link remembers why (shared symbol, graph edge).
  const adj = hunks.map(() => new Map());
  const link = (a, b, why) => {
    if (a === b) return;
    for (const [x, y] of [[a, b], [b, a]]) {
      const e = adj[x].get(y) || { w: 0, why: new Set() };
      e.w++;
      e.why.add(why);
      adj[x].set(y, e);
    }
  };

  // 2. a symbol one hunk defines or edits, used or edited by another code hunk.
  // Docs and data mention everything, and hub symbols (used by many hunks) would merge
  // the whole change into one group, so neither links.
  const isCode = (f) => !/\.(md|mdx|rst|txt|json|jsonl|csv|tsv|ya?ml|toml|lock|svg|excalidraw|log)$/i.test(f);
  const owners = new Map();
  for (const h of hunks) if (isCode(h.file)) for (const s of h.own) (owners.get(s) || owners.set(s, []).get(s)).push(h.i);
  const usedBy = new Map();
  for (const h of hunks) if (isCode(h.file)) for (const s of h.uses) usedBy.set(s, (usedBy.get(s) || 0) + 1);
  const hub = Math.max(3, Math.ceil(hunks.length * 0.15));
  for (const h of hunks) {
    if (!isCode(h.file)) continue;
    for (const s of new Set([...h.uses, ...h.own])) {
      if ((usedBy.get(s) || 0) > hub) continue;
      for (const j of owners.get(s) || []) if (j !== h.i) link(j, h.i, s);
    }
  }

  // 3. Graphify edges between the code each hunk touches
  const graph = loadGraph(root);
  if (graph) {
    const nodesByFile = new Map();
    for (const n of graph.g.nodes) {
      if (!n.source_file) continue;
      const line = +(String(n.source_location || "").match(/\d+/) || [0])[0];
      const rel = path.isAbsolute(n.source_file) ? path.relative(root, n.source_file) : n.source_file;
      (nodesByFile.get(rel) || nodesByFile.set(rel, []).get(rel)).push({ id: n.id, line, label: n.label });
    }
    for (const list of nodesByFile.values()) list.sort((a, b) => a.line - b.line);
    const nodeHunks = new Map();
    for (const h of hunks) {
      const list = nodesByFile.get(h.file) || [];
      const inside = list.filter((n) => n.line >= h.start && n.line <= h.end);
      const enclosing = [...list].reverse().find((n) => n.line && n.line <= h.start);
      for (const n of [...inside, ...(enclosing ? [enclosing] : [])]) (nodeHunks.get(n.id) || nodeHunks.set(n.id, []).get(n.id)).push({ i: h.i, label: n.label });
    }
    for (const [, hs] of nodeHunks) for (let k = 1; k < hs.length; k++) link(hs[0].i, hs[k].i, hs[0].label);
    for (const e of graph.g.links) {
      if (/^(contains|defines|method|imports?|imports_from)$/.test(e.relation)) continue; // too coarse: everything in a file
      const a = nodeHunks.get(e.source || e._src);
      const b = nodeHunks.get(e.target || e._tgt);
      if (a && b) link(a[0].i, b[0].i, `${a[0].label} ${e.relation} ${b[0].label}`);
    }
  }

  // Seeds are the agent's notes: each note is one logical change. Every other hunk joins the
  // note it is most closely linked to (breadth-first, strongest link first). What no note reaches
  // falls back to connected components, and unlinked docs or data share one group.
  const key = new Array(hunks.length).fill(null);
  let frontier = [];
  for (const h of hunks) if (h.note) (key[h.i] = `note:${h.note.id}`), frontier.push(h.i);
  while (frontier.length) {
    const next = [];
    for (const i of frontier)
      for (const [j] of [...adj[i].entries()].sort((x, y) => y[1].w - x[1].w))
        if (key[j] === null) (key[j] = key[i]), next.push(j);
    frontier = next;
  }
  let comp = 0;
  for (const h of hunks) {
    if (key[h.i] !== null) continue;
    if (!isCode(h.file) && !adj[h.i].size) {
      key[h.i] = "docs";
      continue;
    }
    const k = `comp:${comp++}`;
    const stack = [h.i];
    key[h.i] = k;
    while (stack.length) for (const [j] of adj[stack.pop()]) if (key[j] === null) (key[j] = k), stack.push(j);
  }

  const byKey = new Map();
  for (const h of hunks) (byKey.get(key[h.i]) || byKey.set(key[h.i], []).get(key[h.i])).push(h);
  const noteRank = (k) => {
    const id = k.startsWith("note:") ? k.slice(5) : null;
    const order = notes.map((n) => n.id);
    return id ? order.indexOf(id) : 1e6;
  };
  const groups = [...byKey.entries()].map(([k, hs]) => {
    const inGroup = new Set(hs.map((h) => h.i));
    const why = new Map();
    for (const h of hs) for (const [j, e] of adj[h.i]) if (inGroup.has(j)) for (const w of e.why) why.set(w, (why.get(w) || 0) + e.w);
    const top = [...why.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w);
    const note = k.startsWith("note:") ? hs.find((h) => h.note && `note:${h.note.id}` === k).note : null;
    hs.sort((a, b) => a.file.localeCompare(b.file) || a.start - b.start);
    return {
      key: k,
      title: note ? note.title || note.id : k === "docs" ? "Docs and data" : top[0] || `${path.basename(hs[0].file)}:${hs[0].start}`,
      why: top.slice(0, 3),
      hunks: hs,
      files: [...new Set(hs.map((h) => h.file))],
      lines: hs.reduce((a, h) => a + h.added + h.removed, 0),
      rank: k === "docs" ? 2e6 : noteRank(k),
    };
  });
  // One-hunk leftovers with no note go together, so the list stays scannable.
  const singles = groups.filter((g) => g.key.startsWith("comp:") && g.hunks.length === 1);
  if (singles.length > 1) {
    const hs = singles.flatMap((g) => g.hunks);
    groups.splice(0, groups.length, ...groups.filter((g) => !singles.includes(g)), {
      key: "other", title: "Other changes", why: [], hunks: hs, files: [...new Set(hs.map((h) => h.file))],
      lines: hs.reduce((a, h) => a + h.added + h.removed, 0), rank: 1.5e6,
    });
  }
  groups.sort((a, b) => a.rank - b.rank || b.hunks.length - a.hunks.length);
  // A hunk linked into a noted change is explained by that note; flag only what no note covers.
  for (const g of groups) for (const h of g.hunks) h.explained = !!h.note || g.key.startsWith("note:");
  // Edges between groups, for the map: two groups are linked when their code is.
  const gi = new Map();
  groups.forEach((g, i) => g.hunks.forEach((h) => gi.set(h.i, i)));
  const edgeMap = new Map();
  for (const h of hunks)
    for (const [j, e] of adj[h.i]) {
      const a = gi.get(h.i);
      const b = gi.get(j);
      if (a === undefined || b === undefined || a >= b) continue;
      const k = `${a}-${b}`;
      const cur = edgeMap.get(k) || { a, b, w: 0, why: new Set() };
      cur.w += e.w;
      e.why.forEach((w) => cur.why.add(w));
      edgeMap.set(k, cur);
    }
  const edges = [...edgeMap.values()].map((e) => ({ a: e.a, b: e.b, w: e.w, why: [...e.why].slice(0, 2) }));
  return { groups, edges, total: hunks.length, unexplained: hunks.filter((h) => !h.explained && isCode(h.file)), graph: graph ? graph.file : null };
}

module.exports = { parseDiff, group };
