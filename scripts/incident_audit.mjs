#!/usr/bin/env node
// What a run cost and what it wasted. `incident_review.mjs` says what happened in a run; this
// says where the bytes and the tokens went, and which of them went twice.
//
//   node incident_audit.mjs <run folder>              the tables
//   node incident_audit.mjs <run folder> --json       the metrics object the tables are drawn from
//   node incident_audit.mjs <run folder> --record     the tables, and the metrics into metrics.jsonl
//   node incident_audit.mjs --compare <incidents dir> every recorded run, side by side
//
// Every number here is measured, never judged: the token figures come from each session's own
// transcript, which the Stop hook sums through `usageOfTranscript` and logs per turn, so they are
// the harness's accounting and not an estimate. The byte figures are file sizes. The only derived
// numbers are ratios and percentages, computed here and never by a reader.
//
// `--record` keeps one line per run in <incidents dir>/metrics.jsonl, replacing that run's line
// rather than appending a second: a re-audit is the same run measured again, not a new event.
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { join, basename, resolve, dirname } from "node:path";
import { createHash } from "node:crypto";

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const positional = args.filter((a) => !a.startsWith("--"));

const K = (n) => `${Math.round(n / 1024)}K`;
const M = (n) => `${(n / 1e6).toFixed(1)}M`;
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
const num = (n) => n.toLocaleString();

/** Every file under a run folder, with its size. */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out); else out.push({ path: p, name, size: st.size });
  }
  return out;
}

const KINDS = [["brief-ic", "IC briefs"], ["brief-planner", "planner briefs"], ["brief-task", "task briefs"],
  ["brief-sizeup", "size-up briefs"], ["brief-", "other briefs"], ["turn-", "turn files"], ["draft-", "plan drafts"],
  ["review-", "reviews"], ["attached-", "attached evidence"], ["task-", "raw seat objects"], ["leader-", "leader turns"],
  ["state-at-turn", "state snapshots"], ["incident.json", "the state"], ["log.jsonl", "the event log"], ["run.json", "run.json"]];

/** Every metric this tool knows, measured off one run folder. The tables below are a view of it. */
function measure(folder) {
  const files = walk(folder);
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  const state = JSON.parse(readFileSync(join(folder, "incident.json"), "utf8"));
  const stateBytes = JSON.stringify(state).length;

  const byKind = {};
  for (const f of files) {
    const kind = KINDS.find(([pre]) => f.name === pre || f.name.startsWith(pre))?.[1] ?? "everything else";
    byKind[kind] ??= { bytes: 0, files: 0 };
    byKind[kind].bytes += f.size; byKind[kind].files++;
  }

  const byHash = new Map();
  for (const f of files.filter((x) => x.size > 512)) {
    const h = createHash("md5").update(readFileSync(f.path)).digest("hex");
    if (!byHash.has(h)) byHash.set(h, []);
    byHash.get(h).push(basename(f.path));
  }
  const dupeGroups = [...byHash.entries()].filter(([, g]) => g.length > 1);
  const dupeBytes = dupeGroups.reduce((n, [h, g]) => {
    const one = files.find((f) => basename(f.path) === g[0]);
    return n + (one ? one.size * (g.length - 1) : 0);
  }, 0);

  const sections = Object.fromEntries(Object.entries(state).map(([k, v]) => [k, JSON.stringify(v).length]));

  const log = existsSync(join(folder, "log.jsonl"))
    ? readFileSync(join(folder, "log.jsonl"), "utf8").split("\n").filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];
  const calls = log.filter((e) => e.type === "call");
  const seats = {};
  for (const c of calls) {
    const k = c.seat ?? "?";
    seats[k] ??= { calls: 0, cacheRead: 0, cacheWrite: 0, fresh: 0, out: 0, costUsd: 0, seconds: 0, models: [] };
    const s = seats[k];
    s.calls++; s.fresh += c.inputTokens ?? 0; s.out += c.outputTokens ?? 0;
    s.cacheRead += c.cache?.read ?? 0; s.cacheWrite += (c.cache?.write5m ?? 0) + (c.cache?.write1h ?? 0);
    s.costUsd += c.costUsd ?? 0; s.seconds += c.seconds ?? 0;
    if (c.model && !s.models.includes(c.model)) s.models.push(c.model);
  }
  const sum = (f) => Object.values(seats).reduce((n, s) => n + f(s), 0);
  const tokensIn = sum((s) => s.fresh + s.cacheRead + s.cacheWrite);
  const tokensOut = sum((s) => s.out);
  const cacheRead = sum((s) => s.cacheRead);

  const briefFiles = files.filter((f) => f.name.startsWith("brief-") && f.name.endsWith(".json"));
  let briefsCarryingWholeState = 0;
  for (const f of briefFiles) {
    try {
      const b = JSON.parse(readFileSync(f.path, "utf8"));
      if (b.incident?.tasks && b.incident?.claims) briefsCarryingWholeState++;
    } catch {}
  }
  const tasks = state.tasks ?? [];
  const fatTasks = tasks.filter((t) => JSON.stringify(t.result ?? {}).length > 4096).map((t) => ({ id: t.id, bytes: JSON.stringify(t.result).length }));
  const tasksWithoutLine = tasks.filter((t) => t.status === "completed" && t.result && !t.result.summary && !t.result.measure).map((t) => t.id);

  return {
    run: { id: state.incident.id, project: basename(dirname(resolve(folder))), status: state.incident.status, folder: resolve(folder),
           objective: state.incident.objective, measuredAt: new Date().toISOString() },
    shape: { periods: state.period?.number ?? 0, units: (state.units ?? []).length, tasks: tasks.length,
             claims: (state.claims ?? []).length, reports: (state.reports ?? []).length },
    bytes: { total: totalBytes, files: files.length, state: stateBytes, byKind,
             briefs: briefFiles.reduce((n, f) => n + f.size, 0), briefFiles: briefFiles.length,
             duplicateGroups: dupeGroups.length, duplicateBytes: dupeBytes,
             duplicates: dupeGroups.slice(0, 5).map(([, g]) => g) },
    stateSections: sections,
    tokens: { in: tokensIn, out: tokensOut, cacheRead, fresh: sum((s) => s.fresh),
              inPerOut: tokensOut ? Math.round(tokensIn / tokensOut) : 0,
              cacheReadShare: pct(cacheRead, tokensIn), costUsd: Number(sum((s) => s.costUsd).toFixed(2)), calls: calls.length },
    seats,
    checks: { briefsCarryingWholeState, briefShareOfFolder: pct(briefFiles.reduce((n, f) => n + f.size, 0), totalBytes),
              fatTasks, tasksWithoutLine },
  };
}

/** Findings: one per check that fired, each with the numbers that fired it. Order is fixed. */
function findingsOf(m) {
  const f = [];
  if (m.bytes.duplicateGroups)
    f.push({ code: "duplicate-files", detail: `${m.bytes.duplicateGroups} file(s) exist under more than one name, ${K(m.bytes.duplicateBytes)} of copies`, examples: m.bytes.duplicates.map((g) => g.join(" = ")) });
  if (m.checks.fatTasks.length)
    f.push({ code: "bodies-in-record", detail: `${m.checks.fatTasks.length} task(s) keep their body in the record instead of a line and a path`, examples: m.checks.fatTasks.map((t) => `${t.id} ${K(t.bytes)}`) });
  if (m.checks.tasksWithoutLine.length)
    f.push({ code: "no-summary-line", detail: `${m.checks.tasksWithoutLine.length} completed task(s) left no line saying what happened`, examples: m.checks.tasksWithoutLine });
  if (m.checks.briefsCarryingWholeState)
    f.push({ code: "brief-carries-state", detail: `${m.checks.briefsCarryingWholeState} brief(s) carry the whole state, not a slice; each is ~${Math.round(m.bytes.state / 4000)}K tokens for one seat`, examples: [] });
  if (m.checks.briefShareOfFolder > 40)
    f.push({ code: "briefs-dominate-folder", detail: `briefs are ${m.checks.briefShareOfFolder}% of the run folder (${K(m.bytes.briefs)} of ${K(m.bytes.total)})`, examples: [] });
  if (m.tokens.inPerOut > 40)
    f.push({ code: "input-dominates", detail: `${m.tokens.inPerOut} tokens went in for every one out (${M(m.tokens.in)} in, ${num(m.tokens.out)} out); brief size is the lever, not answer length`, examples: [] });
  if (m.tokens.cacheReadShare >= 80)
    f.push({ code: "context-reread", detail: `${m.tokens.cacheReadShare}% of input was cache read, ${M(m.tokens.cacheRead)} tokens: context handed to a seat again on every call it makes`, examples: [] });
  return f;
}

/** A column is right-aligned only when every value in it is a number; prose reads left. */
function table(headers, rows) {
  const numeric = headers.map((_, i) => rows.length > 0 && rows.every((r) => /^[\d,.$%KM()\/-]*$/.test(String(r[i]))));
  const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => ("  " + cells.map((c, i) => (numeric[i] ? String(c).padStart(w[i]) : String(c).padEnd(w[i]))).join("  ")).trimEnd();
  return [line(headers), line(w.map((n) => "-".repeat(n))), ...rows.map(line)].join("\n");
}

function report(m) {
  const f = findingsOf(m);
  const out = [];
  out.push(`incident ${m.run.id} [${m.run.status}]  ${m.run.project}  ${m.shape.periods} period(s), ${m.shape.units} unit(s), ${m.shape.tasks} task(s), ${m.shape.claims} claim(s)`);

  out.push(`\nWHERE THE BYTES ARE  (${K(m.bytes.total)} in ${m.bytes.files} files)`);
  out.push(table(["kind", "size", "share", "files"],
    Object.entries(m.bytes.byKind).sort((a, b) => b[1].bytes - a[1].bytes)
      .map(([k, v]) => [k, K(v.bytes), `${pct(v.bytes, m.bytes.total)}%`, v.files])));

  out.push(`\nTHE STATE  (${K(m.bytes.state)}, ~${Math.round(m.bytes.state / 4000)}K tokens for any seat handed it whole)`);
  out.push(table(["section", "size", "share"],
    Object.entries(m.stateSections).sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([k, v]) => [k, K(v), `${pct(v, m.bytes.state)}%`])));

  if (m.tokens.calls) {
    out.push(`\nMODEL CALLS  (${m.tokens.calls} recorded, from each session's own transcript)`);
    out.push(table(["seat", "calls", "cache read", "fresh in", "out", "in/out", "cost", "models"],
      Object.entries(m.seats).sort((a, b) => (b[1].cacheRead + b[1].fresh) - (a[1].cacheRead + a[1].fresh))
        .map(([k, s]) => [k, s.calls, num(s.cacheRead), num(s.fresh), num(s.out),
                          Math.round((s.fresh + s.cacheRead + s.cacheWrite) / (s.out || 1)), `$${s.costUsd.toFixed(2)}`, s.models.join(", ")])
        .concat([["total", m.tokens.calls, M(m.tokens.cacheRead), num(m.tokens.fresh), num(m.tokens.out), m.tokens.inPerOut, `$${m.tokens.costUsd.toFixed(2)}`, ""]])));
  }

  out.push(`\nWHAT TO FIX  (${f.length})`);
  if (!f.length) out.push("  nothing these checks look for is present in this run.");
  else {
    out.push(table(["check", "what it found"], f.map((x) => [x.code, x.detail])));
    for (const x of f.filter((y) => y.examples.length)) out.push(`    ${x.code}: ${x.examples.slice(0, 4).join("; ")}`);
  }
  return out.join("\n");
}

// --- compare ----------------------------------------------------------------------------------
if (flag("--compare")) {
  const dir = positional[0];
  const path = dir ? join(dir, "metrics.jsonl") : null;
  if (!path || !existsSync(path)) { console.error(`no metrics.jsonl in ${dir ?? "<incidents dir>"}; run an audit with --record first`); process.exit(2); }
  const rows = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  console.log(`${rows.length} recorded run(s) in ${path}\n`);
  console.log(table(["run", "status", "periods", "tasks", "claims", "folder", "state", "tokens in", "out", "in/out", "cache %", "cost", "findings"],
    rows.map((m) => [`${m.run.project}/${m.run.id}`, m.run.status, m.shape.periods, m.shape.tasks, m.shape.claims,
      K(m.bytes.total), K(m.bytes.state), M(m.tokens.in), num(m.tokens.out), m.tokens.inPerOut,
      `${m.tokens.cacheReadShare}%`, `$${m.tokens.costUsd.toFixed(2)}`, (m.findings ?? []).length])));
  process.exit(0);
}

// --- one run ----------------------------------------------------------------------------------
const folder = positional[0];
if (!folder || !existsSync(join(folder, "incident.json"))) {
  console.error("usage: incident_audit.mjs <run folder> [--json|--record]   or   --compare <incidents dir>");
  process.exit(2);
}
const m = measure(folder);
m.findings = findingsOf(m);

if (flag("--json")) { console.log(JSON.stringify(m, null, 2)); process.exit(0); }
console.log(report(m));

if (flag("--record")) {
  // <incidents dir> is the run folder's grandparent: <incidentsDir>/<project>/<id>.
  const incidentsDir = dirname(dirname(resolve(folder)));
  const path = join(incidentsDir, "metrics.jsonl");
  const key = `${m.run.project}/${m.run.id}`;
  const kept = existsSync(path)
    ? readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => `${r.run.project}/${r.run.id}` !== key)
    : [];
  kept.push(m);
  writeFileSync(path, kept.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`\nrecorded as ${key} in ${path} (${kept.length} run(s) recorded; compare them with --compare ${incidentsDir})`);
}
