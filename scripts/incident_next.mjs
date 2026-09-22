#!/usr/bin/env node
// What to do next, read off incident.json: which tasks start now (and together), which leaders
// are due a call and why, which units are done for the pass, what awaits the IC, and what
// blocks. The state machine of the protocol's "When a task ends", as a tool call.
//
//   node incident_next.mjs incident.json
import { loadState, OPEN_TASK, isDeterministic, rootUnit, refreshReady, saveState } from "./incident_lib.mjs";

const [statePath] = process.argv.slice(2);
if (!statePath) { console.error("usage: incident_next.mjs incident.json"); process.exit(2); }
const state = loadState(statePath);
refreshReady(state); saveState(statePath, state);
const root = rootUnit(state);
const out = { start: [], call: [], done: [], ic: [], blocked: [], held: [], stale: [], waiting: [] };

if (state.incident.status === "blocked") out.blocked.push(`the incident is blocked on ${(state.questions ?? []).filter((q) => !q.answer).map((q) => q.id).join(", ")}`);
if (["satisfied", "failed", "stopped"].includes(state.incident.status)) out.blocked.push(`the incident is ${state.incident.status}; nothing runs${state.incident.status === "stopped" ? " until /noscope-resume reopens it" : ""}`);

// The budget: spent against the incident's bound, per dimension; a task whose own bound does not
// fit what remains is held, and a bound already met stops everything but the command turn.
const budget = state.incident.budget ?? {}, spent = state.incident.spent ?? {};
const remaining = { tokens: budget.tokens !== undefined ? budget.tokens - (spent.tokens ?? 0) : undefined, seconds: budget.seconds !== undefined ? budget.seconds - (spent.seconds ?? 0) : undefined };
const budgetMet = (remaining.tokens !== undefined && remaining.tokens <= 0) || (remaining.seconds !== undefined && remaining.seconds <= 0);
if (budgetMet) out.blocked.push(`the budget is spent (${remaining.tokens !== undefined ? `tokens ${spent.tokens}/${budget.tokens}` : ""}${remaining.seconds !== undefined ? ` seconds ${spent.seconds}/${budget.seconds}` : ""}); start nothing; the command turn declares the outcome or the human raises the budget`);
const fits = (t) => !budgetMet && (t.budget?.tokens === undefined || remaining.tokens === undefined || t.budget.tokens <= remaining.tokens) && (t.budget?.seconds === undefined || remaining.seconds === undefined || t.budget.seconds <= remaining.seconds);
// A report that changed the picture ends the pass: runs in flight land, nothing new starts.
const pictureChanged = (state.reports ?? []).some((r) => !r.verdict && r.pictureChanged);

for (const u of (state.units ?? []).filter((x) => x.status === "active")) {
  const mine = (state.tasks ?? []).filter((t) => t.unitId === u.id);
  const ready = mine.filter((t) => t.status === "ready");
  const running = mine.filter((t) => t.status === "running");
  const unheard = mine.filter((t) => t.heard === false);
  const isRoot = root && u.id === root.id;
  for (const t of ready) {
    if (pictureChanged) out.held.push({ taskId: t.id, why: "a report changed the picture; the pass ends when the runs in flight land" });
    else if (!fits(t)) out.held.push({ taskId: t.id, why: budgetMet ? "the budget is spent" : `its bound (${JSON.stringify(t.budget)}) exceeds what remains (${JSON.stringify(remaining)})` });
    else out.start.push({ taskId: t.id, unitId: u.id, resource: t.resource, model: t.model, how: isDeterministic(state, t.resource) ? "run it yourself with incident_evidence.mjs, then apply the ending" : (isRoot ? "spawn a subagent" : `the leader of ${u.id} spawns a subagent`) });
  }
  // A task running longer than its time bound (twice it, or an hour with none) was left by a
  // session that died, or is stuck: the IC ends it as failed or has it spawned again.
  for (const t of running) { const bound = (t.budget?.seconds ?? 1800) * 2 * 1000; if (t.startedAt && Date.now() - new Date(t.startedAt) > bound) out.stale.push({ taskId: t.id, unitId: u.id, since: t.startedAt, why: `running ${Math.round((Date.now() - new Date(t.startedAt)) / 60000)} min, past ${bound / 60000} min; end it with incident_apply.mjs ending {\"error\": \"...\"} or have its leader spawn it again` }); }
  if (isRoot) continue; // command takes no leader turn; the IC judges at its command turn
  const reasons = [];
  if (u.revisePending) reasons.push(`a revise is due: ${u.reviseInstructions}`);
  for (const t of unheard) {
    if (t.status === "failed") reasons.push(`task ${t.id} failed: ${t.reason}`);
    else if (t.status === "insufficient") reasons.push(`task ${t.id} came back insufficient: ${(t.needed ?? []).map((n) => n.kind).join(", ")}`);
    else if (t.status === "completed" && t.consult) reasons.push(`task ${t.id} completed and the leader asked to be consulted on it`);
    else if (t.status === "completed" && t.pictureChanged) reasons.push(`task ${t.id} completed and found what its brief did not expect (pictureChanged)`);
  }
  const awaiting = (state.reports ?? []).some((r) => r.unitId === u.id && !r.verdict);
  if (ready.length === 0 && running.length === 0 && !awaiting && (unheard.length > 0 || mine.length === 0 || mine.every((t) => !OPEN_TASK.has(t.status))))
    reasons.push(mine.length === 0 ? "the unit has no task; it assigns or reports" : "nothing is ready or running and a report is due");
  if (reasons.length) out.call.push({ unitId: u.id, reasons, unheard: unheard.map((t) => t.id) });
  else if (ready.length === 0 && running.length === 0) out.done.push({ unitId: u.id, why: awaiting ? "its report awaits the IC's verdict" : "nothing to run" });
}
for (const u of (state.units ?? []).filter((x) => x.status === "waiting")) out.waiting.push({ unitId: u.id, on: u.waitsOn ?? "an answer", how: "answer its question with incident_apply.mjs answer, or drop the slice at the command turn" });
const awaitingReports = (state.reports ?? []).filter((r) => !r.verdict);
if (awaitingReports.length) out.ic.push(`${awaitingReports.length} report(s) await a verdict: ${awaitingReports.map((r) => `${r.id} (${r.unitId}, ${r.outcome}${r.pictureChanged ? ", picture changed" : ""})`).join("; ")}`);
if (awaitingReports.some((r) => r.pictureChanged)) out.ic.push("a report changed the picture: the pass ends when the runs in flight land; take the command turn");
const openReassignments = (state.reassignments ?? []).filter((r) => r.status === "open");
if (openReassignments.length) out.ic.push(`open reassignment(s) the next plan must take or the IC drop: ${openReassignments.map((r) => r.id).join(", ")}`);
const pending = (state.tasks ?? []).filter((t) => t.status === "pending");
if (out.start.length === 0 && out.call.length === 0 && out.held.length === 0 && (state.tasks ?? []).every((t) => !OPEN_TASK.has(t.status)) && !out.ic.length && !out.blocked.length) out.ic.push("nothing runs and nothing waits: take the command turn (declare the outcome, or set the next period and draft a plan)");
console.log(JSON.stringify({ ...out, pendingOnDependencies: pending.map((t) => `${t.id} on ${(t.dependsOn ?? []).join(", ")}`) }, null, 2));
