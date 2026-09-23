#!/usr/bin/env node
// What a run cost and what it wasted, read off the run folder. `incident_review.mjs` says what
// happened; this says where the bytes and the tokens went, and which of them went twice.
//
//   node incident_audit.mjs <run folder>
//
// Every number is measured, never estimated, except the token figures, which are bytes/4 and
// are labelled as approximate wherever they appear. A finding is printed only when the thing it
// names is actually present, so an empty findings list means the run was clean by these checks.
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";

const folder = process.argv[2];
if (!folder || !existsSync(join(folder, "incident.json"))) {
  console.error("usage: incident_audit.mjs <run folder>   (the folder holding incident.json)");
  process.exit(2);
}
const K = (n) => `${Math.round(n / 1024)}K`;
const tok = (n) => `~${Math.round(n / 4000)}K tokens`;
const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : "0%");
const findings = [];

/** Every file under the run folder, with its size and a hash, so copies can be found. */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push({ path: p, name, size: st.size });
  }
  return out;
}
const files = walk(folder);
const total = files.reduce((n, f) => n + f.size, 0);

// --- Where the folder's bytes are -------------------------------------------------------------
const KINDS = [["brief-ic", "IC briefs"], ["brief-planner", "planner briefs"], ["brief-task", "task briefs"],
  ["brief-sizeup", "size-up briefs"], ["brief-", "other briefs"], ["turn-", "turn files"], ["draft-", "plan drafts"],
  ["review-", "reviews"], ["attached-", "attached evidence"], ["task-", "raw seat objects"], ["leader-", "leader turns"],
  ["state-at-turn", "state snapshots"], ["incident.json", "the state"], ["log.jsonl", "the event log"], ["run.json", "run.json"]];
const bucket = new Map();
for (const f of files) {
  const kind = KINDS.find(([pre]) => f.name === pre || f.name.startsWith(pre))?.[1] ?? "everything else";
  const b = bucket.get(kind) ?? { bytes: 0, n: 0 };
  b.bytes += f.size; b.n++; bucket.set(kind, b);
}

// --- Copies: the same bytes under two names ---------------------------------------------------
const byHash = new Map();
for (const f of files.filter((x) => x.size > 512)) {
  const h = createHash("md5").update(readFileSync(f.path)).digest("hex");
  (byHash.get(h) ?? byHash.set(h, []).get(h)).push(f);
}
const dupes = [...byHash.values()].filter((g) => g.length > 1);
const dupeBytes = dupes.reduce((n, g) => n + g[0].size * (g.length - 1), 0);
if (dupeBytes > 0) findings.push(`${dupes.length} file(s) exist under more than one name, ${K(dupeBytes)} of copies: ${dupes.slice(0, 3).map((g) => g.map((f) => basename(f.path)).join(" = ")).join("; ")}`);

// --- The state: what is in it and what grows --------------------------------------------------
const state = JSON.parse(readFileSync(join(folder, "incident.json"), "utf8"));
const sections = Object.entries(state).map(([k, v]) => [k, JSON.stringify(v).length]).sort((a, b) => b[1] - a[1]);
const stateBytes = JSON.stringify(state).length;

// A task's record should be a line; a body kept in the state is shipped to every seat that
// receives the state, every period, for a body already written to its own file.
const fatTasks = (state.tasks ?? []).filter((t) => JSON.stringify(t.result ?? {}).length > 4096);
if (fatTasks.length) findings.push(`${fatTasks.length} task(s) keep their body in the record instead of a line and a path (${fatTasks.map((t) => `${t.id} ${K(JSON.stringify(t.result).length)}`).join(", ")}); the state goes whole to the planner every period`);
const noSummary = (state.tasks ?? []).filter((t) => t.status === "completed" && t.result && !t.result.summary && !t.result.measure);
if (noSummary.length) findings.push(`${noSummary.length} completed task(s) left no line saying what happened: ${noSummary.map((t) => t.id).join(", ")}`);

// --- What each seat was handed ----------------------------------------------------------------
const briefs = files.filter((f) => f.name.startsWith("brief-") && f.name.endsWith(".json"));
const briefBytes = briefs.reduce((n, f) => n + f.size, 0);
let carriesWholeState = 0;
for (const f of briefs) {
  try {
    const b = JSON.parse(readFileSync(f.path, "utf8"));
    if (b.incident && typeof b.incident === "object" && b.incident.tasks && b.incident.claims) carriesWholeState++;
  } catch {}
}
if (carriesWholeState) findings.push(`${carriesWholeState} brief(s) carry the whole state, not a slice of it; each is ${tok(stateBytes)} of context for one seat`);
if (briefBytes > total * 0.4) findings.push(`briefs are ${pct(briefBytes, total)} of the run folder (${K(briefBytes)} of ${K(total)}); a brief is mostly a copy of the state at the moment it was built`);

// --- Model calls ------------------------------------------------------------------------------
const log = existsSync(join(folder, "log.jsonl"))
  ? readFileSync(join(folder, "log.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];
const calls = log.filter((e) => e.type === "call");
const bySeat = new Map();
for (const c of calls) {
  const s = bySeat.get(c.seat ?? "?") ?? { n: 0, fresh: 0, out: 0, cacheRead: 0, cacheWrite: 0, cost: 0, seconds: 0, models: new Set() };
  // The input a seat is billed for is almost all cache read: the event nests it under `cache`,
  // and reading a flat `cacheRead` gives zero and makes a seat look like it receives nothing.
  s.n++; s.fresh += c.inputTokens ?? 0; s.out += c.outputTokens ?? 0;
  s.cacheRead += c.cache?.read ?? 0; s.cacheWrite += (c.cache?.write5m ?? 0) + (c.cache?.write1h ?? 0);
  s.cost += c.costUsd ?? 0; s.seconds += c.seconds ?? 0; if (c.model) s.models.add(c.model);
  bySeat.set(c.seat ?? "?", s);
}
const totIn = [...bySeat.values()].reduce((n, s) => n + s.fresh + s.cacheRead + s.cacheWrite, 0);
const totOut = [...bySeat.values()].reduce((n, s) => n + s.out, 0);
const totCost = [...bySeat.values()].reduce((n, s) => n + s.cost, 0);
if (totIn && totOut && totIn / totOut > 40) findings.push(`${Math.round(totIn / totOut)} tokens went in for every one that came out (${(totIn / 1e6).toFixed(1)}M in, ${(totOut / 1e3).toFixed(0)}K out); what a seat is handed dominates what it writes, so shrinking briefs is where the money is`);
const reread = [...bySeat.values()].reduce((n, s) => n + s.cacheRead, 0);
if (reread && totIn) findings.push(`${pct(reread, totIn)} of all input was cache read, ${(reread / 1e6).toFixed(1)}M tokens: context handed to a seat again on every call it makes`);

// --- Report -----------------------------------------------------------------------------------
console.log(`incident ${state.incident.id} [${state.incident.status}]  ${folder}`);
console.log(`\nWHERE THE BYTES ARE  (${K(total)} in ${files.length} files)`);
for (const [kind, b] of [...bucket.entries()].sort((a, b) => b[1].bytes - a[1].bytes))
  console.log(`  ${kind.padEnd(22)} ${K(b.bytes).padStart(6)}  ${pct(b.bytes, total).padStart(4)}  across ${b.n} file(s)`);

console.log(`\nTHE STATE  (${K(stateBytes)}, ${tok(stateBytes)} for every seat handed it whole)`);
for (const [k, n] of sections.slice(0, 6)) console.log(`  ${k.padEnd(22)} ${K(n).padStart(6)}  ${pct(n, stateBytes).padStart(4)}`);

if (calls.length) {
  console.log(`\nMODEL CALLS  (${calls.length} recorded)`);
  console.log(`  ${"seat".padEnd(9)} ${"calls".padStart(5)} ${"cache read".padStart(12)} ${"fresh in".padStart(9)} ${"out".padStart(8)} ${"in/out".padStart(7)} ${"cost".padStart(9)}  models`);
  for (const [seat, s] of [...bySeat.entries()].sort((a, b) => (b[1].cacheRead + b[1].fresh) - (a[1].cacheRead + a[1].fresh))) {
    const sin = s.fresh + s.cacheRead + s.cacheWrite;
    console.log(`  ${seat.padEnd(9)} ${String(s.n).padStart(5)} ${s.cacheRead.toLocaleString().padStart(12)} ${s.fresh.toLocaleString().padStart(9)} ${s.out.toLocaleString().padStart(8)} ${String(Math.round(sin / (s.out || 1))).padStart(7)} ${("$" + s.cost.toFixed(2)).padStart(9)}  ${[...s.models].join(", ")}`);
  }
  console.log(`  ${"total".padEnd(9)} ${String(calls.length).padStart(5)} ${"".padStart(12)} ${(totIn / 1e6).toFixed(1).padStart(8)}M ${totOut.toLocaleString().padStart(8)} ${String(Math.round(totIn / (totOut || 1))).padStart(7)} ${("$" + totCost.toFixed(2)).padStart(9)}`);
}

console.log(`\nWHAT TO FIX  (${findings.length})`);
if (!findings.length) console.log("  nothing these checks look for is present in this run.");
for (const f of findings) console.log(`  - ${f}`);
