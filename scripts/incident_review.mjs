#!/usr/bin/env node
// The After Action Review, read from incident.json and log.jsonl: periods, calls and cost
// where recorded, tasks and their seconds, verdicts by kind, revisions and reassignments,
// refusals, claims and evidence counts, wall time per period beside the tasks' summed seconds
// and the period's critical path.
//
//   node incident_review.mjs incident.json
import { loadState, readLog } from "./incident_lib.mjs";

const [statePath] = process.argv.slice(2);
if (!statePath) { console.error("usage: incident_review.mjs incident.json"); process.exit(2); }
const state = loadState(statePath); const log = readLog(statePath);
const lines = [];
const say = (s) => lines.push(s);
const secs = (a, b) => (a && b ? (new Date(b) - new Date(a)) / 1000 : null);
const fmt = (n) => (n === null || n === undefined ? "?" : `${n.toFixed(1)} s`);

say(`incident ${state.incident.id} [${state.incident.status}]  ${state.incident.objective}`);
say(`periods: ${state.period?.number ?? 0}; units: ${state.units.length} (${state.units.filter((u) => u.status === "closed").length} closed); tasks: ${state.tasks.length}`);

// periods from command.turned events
const turns = log.filter((e) => e.type === "command.turned");
turns.forEach((t, i) => {
  const next = turns[i + 1]; const end = next ? next.at : log[log.length - 1]?.at;
  const inPeriod = log.filter((e) => e.sequence >= t.sequence && (!next || e.sequence < next.sequence));
  const tasksIn = state.tasks.filter((x) => inPeriod.some((e) => e.type === "task.started" && e.taskId === x.id));
  const taskSecs = tasksIn.map((x) => ({ id: x.id, s: secs(x.startedAt, x.endedAt) ?? 0, deps: x.dependsOn ?? [] }));
  const sum = taskSecs.reduce((a, x) => a + x.s, 0);
  const memo = new Map(); const path = (id) => { if (memo.has(id)) return memo.get(id); const x = taskSecs.find((y) => y.id === id); if (!x) return { s: 0, chain: [] }; const best = x.deps.map(path).reduce((a, b) => (b.s > a.s ? b : a), { s: 0, chain: [] }); const r = { s: best.s + x.s, chain: [...best.chain, id] }; memo.set(id, r); return r; };
  const crit = taskSecs.map((x) => path(x.id)).reduce((a, b) => (b.s > a.s ? b : a), { s: 0, chain: [] });
  const wall = secs(t.at, end);
  say(`period ${t.period}  ${t.at}  assessment ${t.situation?.assessment?.kind ?? "(none)"}: ${t.situation?.assessment?.why ?? ""}`);
  for (const o of t.objectives ?? []) say(`  objective: ${o}`);
  for (const e of inPeriod.filter((x) => x.type === "report.reviewed")) say(`  verdict on ${e.unitId}'s report ${e.reportId}: ${e.verdict}: ${e.why ?? ""}`);
  for (const e of inPeriod.filter((x) => x.type === "unit.reported")) say(`  ${e.unitId} reported ${e.outcome}${e.pictureChanged ? ", picture changed" : ""}${e.revision ? ` (revision ${e.revision})` : ""}`);
  for (const x of tasksIn) say(`  ${x.id} ${x.resource}${x.model ? " " + x.model : ""}: ${x.status}, ${fmt(secs(x.startedAt, x.endedAt))}${x.measure ? "; evidence: " + x.measure : ""}${x.status === "completed" && !x.measure ? "; claims " + state.claims.filter((c) => c.provenance?.taskId === x.id).length : ""}`);
  say(`  wall time: period ${fmt(wall)}; ${tasksIn.length} task(s) summing ${fmt(sum)}; critical path ${fmt(crit.s)} (${crit.chain.join(" -> ") || "none"}); parallel possible ${crit.s ? (sum / crit.s).toFixed(2) : "?"}x`);
});

// calls and cost, when recorded
const calls = log.filter((e) => e.type === "call");
if (calls.length) {
  const by = new Map();
  for (const c of calls) { const k = `${c.seat} ${c.model}`; const v = by.get(k) ?? { n: 0, input: 0, output: 0, seconds: 0, cost: 0 }; v.n++; v.input += c.inputTokens ?? 0; v.output += c.outputTokens ?? 0; v.seconds += c.seconds ?? 0; v.cost += c.costUsd ?? 0; by.set(k, v); }
  say("calls by seat and model:");
  for (const [k, v] of by) say(`  ${k}: ${v.n} call(s), in ${v.input}, out ${v.output}, ${v.seconds.toFixed(1)} s, $${v.cost.toFixed(2)}`);
  say(`cost: $${[...by.values()].reduce((a, v) => a + v.cost, 0).toFixed(2)}`);
} else say("calls: none recorded (log a {type: \"call\", seat, model, inputTokens, outputTokens, seconds, costUsd} event per model call to price the run)");

const verdicts = log.filter((e) => e.type === "report.reviewed");
say(`report verdicts: ${verdicts.length}: ${["accepted", "revise", "reassign"].map((k) => `${verdicts.filter((v) => v.verdict === k).length} ${k}`).join(", ")}`);
say(`revisions: ${log.filter((e) => e.type === "unit.revised").length}; reassignments: ${state.reassignments.length} (${["open", "taken", "dropped"].map((k) => `${state.reassignments.filter((r) => r.status === k).length} ${k}`).join(", ")})`);
say(`leader turns: ${log.filter((e) => e.type === "unit.reported" || e.type === "unit.continued").length} (${log.filter((e) => e.type === "unit.reported").length} reports); endings heard with no call: ${log.filter((e) => e.type === "unit.heard").length}`);
say(`refusals: ${log.filter((e) => e.refusals).length}`);
const rejected = log.filter((e) => /\.rejected$/.test(e.type));
say(`rejections: ${rejected.length}${rejected.length ? " (" + Object.entries(rejected.reduce((m, e) => (m[e.type] = (m[e.type] ?? 0) + 1, m), {})).map(([k, v]) => `${v} ${k.replace(".rejected", "")}`).join(", ") + ")" : ""}`);
const reviews = log.filter((e) => e.type === "plan.reviewed");
say(`reviews: ${reviews.length}: ${["approve", "correct", "amend"].map((k) => `${reviews.filter((r) => r.verdict === k).length} ${k}`).join(", ")}; patches applied: ${reviews.reduce((n, r) => n + (r.patches?.length ?? 0), 0)}`);
say(`resource requests: ${log.filter((e) => e.type === "unit.waiting").length}; resource gaps: ${(state.resourceGaps ?? []).length}`);
say(`questions: ${state.questions.length} (${state.questions.filter((q) => q.answeredBy === "human").length} answered by the human, ${state.questions.filter((q) => q.answeredBy === "ic").length} by the IC)`);
say(`claims: ${state.claims.length} (${state.claims.filter((c) => c.basis === "observed").length} observed, ${state.claims.filter((c) => c.basis === "inferred").length} inferred); evidence: ${state.evidence.length} deterministic result(s)`);
say(`open items: ${(state.situation?.open ?? []).length} (${(state.situation?.open ?? []).filter((o) => o.deferred).length} deferred)`);
const first = log[0]?.at, last = log[log.length - 1]?.at;
say(`wall time, whole: ${fmt(secs(first, last))} from ${first} to ${last}`);
console.log(lines.join("\n"));
