#!/usr/bin/env node
// Runs a deterministic resource and prints the {output, measure} object that
// `incident_apply.mjs ending` records as evidence, so a command's output is never turned into
// claims and always carries its count.
//
//   node incident_evidence.mjs grep        <root> <pattern> [glob]      matches with path, line and text
//   node incident_evidence.mjs read        <path> [from] [to]           a file, or a line range
//   node incident_evidence.mjs git_history <cwd> [n]                    the last n commits and the working-tree changes
//   node incident_evidence.mjs check_path  <path>
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { measureOf } from "./incident_lib.mjs";

const [cap, ...args] = process.argv.slice(2);
let output;
try {
  if (cap === "grep") {
    const [root, pattern, glob] = args; const re = new RegExp(pattern); const matches = [];
    const globRe = glob ? new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$") : null;
    const walk = (dir) => { for (const name of readdirSync(dir)) { if (name === "node_modules" || name === ".git") continue; const p = join(dir, name); const st = statSync(p); if (st.isDirectory()) walk(p); else if (!globRe || globRe.test(name)) { let text; try { text = readFileSync(p, "utf8"); } catch { continue; } text.split("\n").forEach((line, i) => { if (re.test(line)) matches.push({ path: p, line: i + 1, text: line.slice(0, 300) }); }); } } };
    if (!existsSync(resolve(root))) throw new Error(`no such root ${root}`);
    walk(resolve(root)); output = { root: resolve(root), pattern, matches };
  } else if (cap === "read") {
    const [path, from, to] = args; const lines = readFileSync(resolve(path), "utf8").split("\n");
    const a = from ? Number(from) : 1; const b = to ? Number(to) : lines.length;
    output = { path: resolve(path), from: a, to: b, content: lines.slice(a - 1, b).join("\n") };
  } else if (cap === "git_history") {
    const [cwd, n] = args; const c = resolve(cwd ?? ".");
    const commits = execFileSync("git", ["log", `-${n ?? 10}`, "--format=%h %ad %s", "--date=short"], { cwd: c, encoding: "utf8" }).trim().split("\n").filter(Boolean);
    const changes = execFileSync("git", ["status", "--porcelain"], { cwd: c, encoding: "utf8" }).trim().split("\n").filter(Boolean);
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: c, encoding: "utf8" }).trim();
    output = { cwd: c, branch, commits, changes };
  } else if (cap === "check_path") {
    const [path] = args; const p = resolve(path); const exists = existsSync(p);
    output = { path: p, exists, kind: exists ? (statSync(p).isDirectory() ? "directory" : "file") : null };
  } else { console.error("usage: incident_evidence.mjs grep|read|git_history|check_path ..."); process.exit(2); }
} catch (e) { console.log(JSON.stringify({ error: String(e.message ?? e) })); process.exit(1); }
console.log(JSON.stringify({ output, measure: measureOf(cap, output) }, null, 2));
