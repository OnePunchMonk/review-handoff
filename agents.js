// One way to run any coding agent, so nothing in the extension is tied to one vendor.
//
// A profile is {id, label, cli, model, effort, bestFor} where cli is:
//   "claude"  Claude Code   (headless: claude -p)
//   "codex"   Codex CLI     (headless: codex exec)
//   "command" anything else: give `command` (headless argv) and optionally `interactive`
//             (argv for a task terminal). Placeholders: {prompt} {model} {effort} {cwd}.
//             e.g. {"cli":"command","command":["gemini","-m","{model}","-p","{prompt}"]}
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const cp = require("child_process");

const HOME = os.homedir();
const bin = (name) => [`${HOME}/.local/bin/${name}`, "/opt/homebrew/bin/" + name, "/usr/local/bin/" + name].find((p) => fs.existsSync(p)) || name;

/** A clean environment: never inherit a parent Claude session's markers; find user-installed CLIs. */
function env(extra) {
  const e = { ...process.env, ...extra, PATH: [`${HOME}/.local/bin`, "/opt/homebrew/bin", "/usr/local/bin", process.env.PATH].join(":") };
  for (const k of Object.keys(e)) if (k.startsWith("CLAUDE_CODE_") || k === "CLAUDECODE") delete e[k];
  return e;
}

const fill = (argv, vars) => argv.map((a) => a.replace(/\{(prompt|model|effort|cwd)\}/g, (_, k) => vars[k] ?? ""));

/**
 * Headless invocation. access: "read" (look only), "review" (may write .review/), "write" (workspace).
 * claudeTools: extra Claude Code tool rules for this job. Returns {cmd, args, stdin, outFile}.
 */
function headless(p, prompt, { cwd, access = "read", claudeTools = [], claudeBin } = {}) {
  if (p.cli === "codex") {
    const outFile = path.join(os.tmpdir(), `rh-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    const args = ["exec", "-m", p.model, "-c", `model_reasoning_effort="${p.effort}"`, "-s", access === "read" ? "read-only" : "workspace-write", "-C", cwd, "--skip-git-repo-check", "-o", outFile, "-"];
    return { cmd: bin("codex"), args, stdin: prompt, outFile };
  }
  if (p.cli === "command") {
    const argv = fill(p.command || [], { prompt, model: p.model, effort: p.effort, cwd });
    return { cmd: argv[0], args: argv.slice(1), stdin: (p.command || []).some((a) => a.includes("{prompt}")) ? null : prompt };
  }
  const read = ["Read", "Grep", "Glob", "Skill", "Bash(git diff:*)", "Bash(git show:*)", "Bash(git log:*)", "Bash(git ls-files:*)", "Bash(ls:*)"];
  const write = access === "review" ? ["Bash(mv .review/:*)", "Edit(.review/**)"] : access === "write" ? ["Edit"] : [];
  const args = ["-p", prompt, "--output-format", "json", "--allowedTools", ...read, ...write, ...claudeTools];
  if (p.model) args.push("--model", p.model);
  if (p.effort) args.push("--effort", p.effort);
  return { cmd: claudeBin || bin("claude"), args, stdin: null };
}

/** The agent's final text, whatever CLI produced it. */
function resultText(p, inv, stdout) {
  if (inv.outFile) {
    try {
      return fs.readFileSync(inv.outFile, "utf8");
    } catch {
      return stdout;
    } finally {
      fs.rm(inv.outFile, { force: true }, () => {});
    }
  }
  if (p.cli === "claude" || !p.cli) {
    const o = JSON.parse(stdout);
    if (o.is_error) throw new Error(o.result || "the agent returned an error");
    return o.result;
  }
  return stdout;
}

/** Spawn headless; caller handles the process (logs, cancel). */
function spawn(p, prompt, opts) {
  const inv = headless(p, prompt, opts);
  const child = cp.spawn(inv.cmd, inv.args, { cwd: opts.cwd, env: env(opts.env), stdio: [inv.stdin ? "pipe" : "ignore", opts.stdout || "pipe", opts.stderr || "pipe"] });
  if (inv.stdin) child.stdin.end(inv.stdin);
  return { child, inv };
}

/** Run headless and resolve with the agent's final text. */
function run(p, prompt, opts) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let child;
    let inv;
    try {
      ({ child, inv } = spawn(p, prompt, opts));
    } catch (e) {
      return resolve({ error: e.message });
    }
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = opts.timeout ? setTimeout(() => child.kill(), opts.timeout) : null;
    child.on("error", (e) => resolve({ error: e.message }));
    child.on("close", (code) => {
      clearTimeout(timer);
      try {
        const text = resultText(p, inv, out);
        if (!text && code) throw new Error((err || out).trim().split("\n").pop() || `exit ${code}`);
        resolve({ text });
      } catch (e) {
        resolve({ error: (e.message || String(e)).slice(0, 300) });
      }
    });
  });
}

/** Shell command for an interactive task terminal. */
function interactive(p, prompt, { cwd, plan, claudeBin }) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  if (p.cli === "codex") {
    const text = plan ? `First reply with a short plan and wait for my go-ahead.\n\n${prompt}` : prompt;
    return `${q(bin("codex"))} -m ${q(p.model)} -c ${q(`model_reasoning_effort="${p.effort}"`)} -s workspace-write -a on-request ${q(text)}`;
  }
  if (p.cli === "command") {
    const text = plan ? `First reply with a short plan and wait for my go-ahead.\n\n${prompt}` : prompt;
    return fill(p.interactive || p.command || [], { prompt: text, model: p.model, effort: p.effort, cwd }).map(q).join(" ");
  }
  return `${q(claudeBin || bin("claude"))}${p.model ? ` --model ${q(p.model)}` : ""}${p.effort ? ` --effort ${q(p.effort)}` : ""}${plan ? " --permission-mode plan" : ""} ${q(prompt)}`;
}

module.exports = { headless, spawn, run, interactive, env, bin };
