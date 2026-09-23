#!/usr/bin/env node
// Assembles a brief from incident.json and log.jsonl, in the shape the validator's brief mode
// checks, so the two agree by construction. Prints the JSON to stdout; run the validator on it
// before sending.
//
//   node incident_brief.mjs sizeup      incident.json
//   node incident_brief.mjs ic          incident.json [--whole]    the IC's own briefing: the change since its last turn, plus the keys of the
//                                                                  state that changed since that turn (every key with --whole, or on a fresh session)
//   node incident_brief.mjs planner     incident.json
//   node incident_brief.mjs orientation incident.json <unit-id>
//   node incident_brief.mjs turn        incident.json <unit-id>
//   node incident_brief.mjs task        incident.json <task-id>
//   node incident_brief.mjs review      incident.json <draft.json> [warnings.txt]
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
/**
 * A task's result as a brief attaches it: the record keeps a line and the body stays in the
 * file the seat's object was read from, so evidence is still attached whole without the state
 * carrying it. An older run, or a file since removed, falls back to what the record holds.
 */
function resultBodyOf(d) {
  if (!d?.result) return null;
  const p = d.result.body;
  if (p) { try { return JSON.parse(readFileSync(p, "utf8")); } catch {} }
  return d.result;
}
import { loadState, readLog, isDeterministic, rootUnit, resolveModel, runConfig, AVAILABLE_MODELS, fieldListOf, checklistText, aliasOf} from "./incident_lib.mjs";

const [kind, statePath, id, extra] = process.argv.slice(2);
if (!kind || !statePath) { console.error("usage: see the header of incident_brief.mjs"); process.exit(2); }
const state = loadState(statePath);
const log = readLog(statePath);
const clip = (s, n = 300) => (typeof s === "string" && s.length > n ? s.slice(0, n) + "…" : s);
const claimLine = (c) => ({ id: c.id, subject: c.subject, predicate: c.predicate, basis: c.basis, confidence: c.confidence });
const ending = (t) => {
  const e = { taskId: t.id, resource: t.resource, status: t.status };
  if (t.status === "completed") { if (isDeterministic(state, t.resource)) e.evidence = t.measure; else { e.summary = clip(t.result?.summary); e.claims = state.claims.filter((c) => c.provenance?.taskId === t.id).map(claimLine); } }
  if (t.status === "failed") { e.reason = t.reason; e.cancelled = state.tasks.filter((x) => x.because === t.id).map((x) => x.id); }
  if (t.status === "insufficient") e.needed = t.needed;
  if (t.consult) e.consult = true;
  if (t.pictureChanged) e.pictureChanged = true;
  return e;
};
const checklist = "The rules your draft is held to are under `rules` in this brief (the protocol's checklist); incident_validator.mjs applies them. Everything you may weigh is in this brief: read no file but this one, then run `node <plugin root>/scripts/incident_validator.mjs plan <run folder>/incident.json <your draft>` on your draft before returning it and fix every REJECT.";

let out;
// The inferences a picture is standing on, and what would fall with each. A decision seat is
// told to weigh an inferred claim by what rests on it rather than by its confidence, and this
// is that question answered from the record instead of from memory: an empty openItems and
// tasks is a claim nothing carries, which the rule says to go on from; a claim with tasks
// hanging off it is one whose wrongness would misdirect them. A join over arrays already
// loaded — no file is read for it.
function restingOn(situation, claims, tasks, unitId = null) {
  const OPEN = new Set(["pending", "ready", "running"]);
  const byId = new Map((claims ?? []).map((c) => [c.id, c]));
  const open = situation?.open ?? [];
  const live = (tasks ?? []).filter((x) => OPEN.has(x.status) && (unitId === null || x.unitId === unitId));
  return (situation?.evidence ?? [])
    .filter((e) => e.stance === "for")
    .map((e) => byId.get(e.claimId))
    .filter((c) => c && c.basis === "inferred")
    .map((c) => {
      const items = open.filter((o) => String(o.settledBy ?? "").includes(c.id));
      const ids = new Set(items.map((o) => o.id));
      return {
        claimId: c.id, subject: c.subject, predicate: c.predicate, confidence: c.confidence,
        openItems: items.map((o) => o.id),
        // A task reaches the claim either by reading it or by settling an item that cites it.
        tasks: live.filter((x) => (x.evidenceFrom?.claims ?? []).includes(c.id)
          || (x.settles ?? []).some((s) => ids.has(s))).map((x) => x.id),
      };
    });
}

if (kind === "sizeup") {
  out = { objective: state.incident.objective, constraints: state.incident.constraints, priorities: state.incident.priorities, workingDirectory: state.incident.workingDirectory, availableModels: AVAILABLE_MODELS, returns: fieldListOf("IncidentBriefing"), ask: "Size the incident up with the tools you have, in at most a dozen looks (a check is one look at whether a thing exists, answers, or is where the objective says it is; what the incident turns on is for the units to establish, not for you to read your way to), and return an IncidentBriefing: the kind read from the objective's verb, the dominant problem, what you checked, initial objectives, units sketched, hazards, any question only the human could answer, as proposals to the Incident Commander, and the model right-sized for this incident for each seat above a task (incomingCommander for the IC, seatModels.planner and seatModels.leader), chosen from availableModels with a why each." };
} else if (kind === "ic") {
  const lastTurn = [...log].reverse().find((e) => e.type === "command.turned");
  const since = lastTurn ? lastTurn.sequence : -1;
  const recent = log.filter((e) => e.sequence > since);
  const reportsSince = state.reports.filter((r) => !r.verdict);
  const change = {
    reports: reportsSince.map((r) => ({ id: r.id, unitId: r.unitId, outcome: r.outcome, pictureChanged: r.pictureChanged, changes: r.changes, why: r.why, suggestion: r.suggestion, revision: r.revision, situation: r.situation,
      work: state.tasks.filter((t) => t.unitId === r.unitId && t.endedAt && (!r.at || t.endedAt <= r.at)).map(ending) })),
    commandTasks: state.tasks.filter((t) => t.unitId === rootUnit(state)?.id && t.endedAt && recent.some((e) => e.taskId === t.id && ["task.completed", "task.failed", "task.insufficient"].includes(e.type))).map(ending),
    answers: recent.filter((e) => e.type === "question.answered").map((e) => ({ questionId: e.questionId, answer: e.answer })),
    refusals: recent.filter((e) => e.refusals).map((e) => ({ taskId: e.taskId, refusals: e.refusals })),
    rejections: recent.filter((e) => e.type === "command.rejected" || e.type === "plan.rejected").map((e) => e.reasons),
    cancelled: recent.filter((e) => e.type === "task.cancelled").map((e) => ({ taskId: e.taskId, because: e.because, reason: e.reason })),
  };
  // The state by changed keys (R5-11): what differs from the snapshot incident_apply.mjs command
  // wrote at the last turn; whole on a fresh session (--whole) or before any turn.
  const snapPath = join(dirname(statePath), "hooks", "state-at-turn.json");
  const whole = extra === "--whole" || id === "--whole" || !existsSync(snapPath) || !lastTurn;
  let incident = state, unchanged = [];
  if (!whole) {
    const snap = JSON.parse(readFileSync(snapPath, "utf8"));
    incident = {}; for (const k of Object.keys(state)) { if (JSON.stringify(state[k]) !== JSON.stringify(snap[k])) incident[k] = state[k]; else unchanged.push(k); }
  }
  const resting = restingOn(state.situation, state.claims, state.tasks);
  out = { change, incident, ...(resting.length ? { restingOn: resting } : {}), ...(unchanged.length ? { unchanged, note: "incident.json keys unchanged since your last turn are listed under unchanged and omitted; you read them then" } : {}), ask: state.period?.number ? "Write your CommandTurn: one verdict per unit whose report is listed, the period's objectives and priorities, your situation edited from the one in incident.json (carry an open item by its id; new ones without), deterministic tasks under command if you need a fact, and the status. Run `node incident_validator.mjs command incident.json turn.json` before applying it." : "First turn: evaluate each item of the briefing (accepted, rewritten, discarded), rule on each question it proposed by number (accept, discard with a why, or answer), edit the seeded situation into your own picture, set the first period's objectives and priorities, and the status. Run `node incident_validator.mjs command incident.json turn.json` before applying it." };
} else if (kind === "planner") {
  // The configured models: the planner runs on seatModel (the IC spawns it so), and names each
  // unit's leader model as `models.leader` says: a fixed id, or its own choice under "Smallest model that fits".
  const cfg = runConfig(statePath);
  // What the noscope TypeScript runtime's planner saw as sections 4 to 6: the window since the last applied plan.
  const lastPlan = [...log].reverse().find((e) => e.type === "plan.applied" && e.actor === "ic");
  const sinceSeq = lastPlan ? lastPlan.sequence : -1;
  const recentIds = (types) => new Set(log.filter((e) => e.sequence > sinceSeq && types.includes(e.type)).map((e) => e.taskId));
  const sinceLastPlan = {
    tasksCompleted: state.tasks.filter((t) => recentIds(["task.completed"]).has(t.id)).map(ending),
    tasksInsufficientOrFailed: state.tasks.filter((t) => recentIds(["task.insufficient", "task.failed"]).has(t.id)).map(ending),
    reports: state.reports.filter((r) => log.some((e) => e.sequence > sinceSeq && e.type === "unit.reported" && e.reportId === r.id)).map((r) => ({ id: r.id, unitId: r.unitId, outcome: r.outcome, pictureChanged: r.pictureChanged, verdict: r.verdict ?? null, changes: r.changes, situation: r.situation })),
  };
  // What a planner plans from, not the whole record. It is spawned fresh each period and has no
  // orientation of its own — it works the IC's — so it needs the picture, the tree, what is
  // established and what is still open, plus what the last plan accomplished. It does not need
  // every finished task's record: those tasks are in sinceLastPlan, and their bodies are in the
  // files the record points at. On run 001 that is 46K where the whole state is 180K.
  const OPEN_NOW = new Set(["pending", "ready", "running"]);
  const plannerBase = {
    incident: { objective: state.incident.objective, constraints: state.incident.constraints, priorities: state.incident.priorities,
                workingDirectory: state.incident.workingDirectory, status: state.incident.status,
                budget: state.incident.budget, spent: state.incident.spent },
    period: state.period,
    situation: state.situation,
    units: (state.units ?? []).filter((u) => u.status !== "closed")
      .map((u) => ({ id: u.id, parentId: u.parentId, type: u.type, objective: u.objective, scope: u.scope ?? null,
                     status: u.status, leader: u.leader, equipment: u.equipment, bashAllowlist: u.bashAllowlist })),
    // Claim lines: what is established and how firmly. The measured object belongs to the IC's
    // picture, and a planner choosing the next tasks works from subject, basis and confidence.
    claims: (state.claims ?? []).map(claimLine),
    openTasks: (state.tasks ?? []).filter((t) => OPEN_NOW.has(t.status))
      .map((t) => ({ id: t.id, unitId: t.unitId, resource: t.resource, objective: t.objective, scope: t.scope ?? null, status: t.status, dependsOn: t.dependsOn ?? [] })),
    evidence: state.evidence ?? [],
    reassignments: (state.reassignments ?? []).filter((r) => r.status === "open"),
    questions: (state.questions ?? []).filter((q) => !q.answer),
    resources: state.resources,
  };
  out = { incident: plannerBase, checklist, rules: checklistText(), sinceLastPlan, returns: fieldListOf("ActionPlan"), models: { leader: resolveModel("leader", cfg) ?? "claude-sonnet-5", provider: "claude-code" }, seatModel: resolveModel("planner", cfg) ?? "claude-opus-5", ask: "Draft this operational period's tactics as an ActionPlan, a suggestion for the Incident Commander: units to open or close each with the territory it covers, tasks with resource, inputs, expected output, completion criteria, dependencies and the evidence each reads, the smallest model that fits each (Opus only with a modelWhy), what each task settles among situation.open, and any reassignment taken. Independent work runs in the same period. A unit's scope and a task's are decisions, not labels: every other unit is shown a unit's and every sibling task is shown a task's, so two that overlap do the same work twice and neither reports the gap between them." };
} else if (kind === "orientation") {
  const u = state.units.find((x) => x.id === id); if (!u) { console.error(`no unit ${id}`); process.exit(1); }
  const siblings = state.units.filter((x) => x.parentId === u.parentId && x.id !== u.id && x.status === "active").map((x) => ({ id: x.id, objective: x.objective, scope: x.scope ?? null }));
  const children = state.units.filter((x) => x.parentId === u.id && x.status === "active").map((x) => ({ id: x.id, objective: x.objective, scope: x.scope ?? null }));
  out = { objective: state.incident.objective, periodObjectives: state.period?.objectives ?? [], unit: { id: u.id, objective: u.objective, scope: u.scope ?? null, equipment: u.equipment, bashAllowlist: u.bashAllowlist }, hierarchy: { parent: u.parentId, siblings, children } };
  if (u.takes) { const r = state.reassignments.find((x) => x.id === u.takes); if (r) out.reassignment = { id: r.id, from: r.unitId, objective: r.objective, instructions: r.instructions, why: r.why, claims: state.claims.filter((c) => r.claims.includes(c.id)).map(claimLine) }; }
  if (u.lastPicture) out.lastPicture = u.lastPicture;
  // The unit's tasks so far, so a leader spawned mid-life (after a handoff or a crash) starts from what its unit already did.
  const mine = state.tasks.filter((t) => t.unitId === u.id);
  if (mine.length) out.tasks = mine.map((t) => t.endedAt ? ending(t) : { taskId: t.id, resource: t.resource, status: t.status, objective: t.objective });
  out.ask = "You lead this unit. Assign tasks under it, or report against its objective, as a LeaderTurn; you are called only on a decision.";
} else if (kind === "turn") {
  const u = state.units.find((x) => x.id === id); if (!u) { console.error(`no unit ${id}`); process.exit(1); }
  const mine = state.tasks.filter((t) => t.unitId === u.id);
  const restingUnit = restingOn(u.lastPicture, state.claims, state.tasks, u.id);
  out = { returns: fieldListOf("LeaderTurn"), ...(restingUnit.length ? { restingOn: restingUnit } : {}), unheard: mine.filter((t) => t.heard === false).map(ending), refused: (u.refusedAssignments ?? []), ready: mine.filter((t) => t.status === "ready").map((t) => t.id), running: mine.filter((t) => t.status === "running").map((t) => t.id) };
  if (u.revisePending) { const r = state.reports.find((x) => x.id === u.reviseReportId); out.revise = { instructions: u.reviseInstructions, why: u.reviseWhy, report: r ? { id: r.id, outcome: r.outcome, changes: r.changes, situation: r.situation } : null, periodObjectives: state.period?.objectives ?? [] }; }
  out.ask = out.ready.length === 0 && out.running.length === 0 ? "No ready task remains in your unit. Assign tasks for what is missing and continue, or file your report against the unit's objective, as a LeaderTurn." : "Decide: assign tasks under your unit, flag consult on any you want to judge when it ends, or report, as a LeaderTurn.";
} else if (kind === "task") {
  const t = state.tasks.find((x) => x.id === id); if (!t) { console.error(`no task ${id}`); process.exit(1); }
  const u = state.units.find((x) => x.id === t.unitId);
  out = { returns: (fieldListOf(t.resource) ?? fieldListOf("investigate")) + `\n- \`taskId\` (string, required by the plugin): "${t.id}", so the record knows which task the result ends`, objective: state.incident.objective, unit: { id: u?.id, objective: u?.objective },
    evidence: { claims: state.claims.filter((c) => (t.evidenceFrom?.claims ?? []).includes(c.id)).map((c) => ({ ...claimLine(c), object: c.object })), results: (t.evidenceFrom?.tasks ?? []).map((tid) => { const d = state.tasks.find((x) => x.id === tid); return { taskId: tid, resource: d?.resource, result: resultBodyOf(d) }; }) },
    siblings: state.tasks.filter((x) => x.unitId === t.unitId && x.id !== t.id && ["pending", "ready", "running"].includes(x.status))
      .map((x) => ({ taskId: x.id, resource: x.resource, status: x.status, scope: x.scope ?? null })),
    task: { id: t.id, resource: t.resource, objective: t.objective, scope: t.scope, inputs: t.inputs, expectedOutput: t.expectedOutput, completionCriteria: t.completionCriteria, evidenceRequired: t.evidenceRequired, instructions: t.instructions, model: t.model, modelAlias: aliasOf(t.model), budget: t.budget, strikeTeam: t.strikeTeam },
    ask: `Work inside your own scope. The other tasks of your unit are listed under siblings with the territory each owns; where your work runs into one of theirs, say so in your findings and leave it to them rather than widening. Do this one task with the tools you have and return the ${t.resource} result object: outcome answered or insufficient (naming the kind of lack), findings, and claims each with subject, predicate, basis, confidence and the task ids it cites. Run \`node incident_validator.mjs result incident.json result.json ${t.id}\` before returning it.` };
} else if (kind === "review") {
  const draft = JSON.parse(readFileSync(id, "utf8"));
  const warnings = extra ? readFileSync(extra, "utf8").split("\n").filter((l) => l.startsWith("WARN")) : [];
  out = { draft: { ...draft, createTasks: (draft.createTasks ?? []).map((t, i) => ({ position: `#${i + 1}`, ...t })) }, warnings, valid: "Every rule of the checklist holds on this draft; review it for substance only.", questions: ["Does it work every open item of your situation?", "Does it serialize work that is independent?", "Does it put a seat on a larger model without a reason?", "Does any unit objective or task brief state what you believe rather than what is to be established?"], ask: "Answer as a ReviewTurn: approve; correct with patches (set a draft task's field by ref or #N, add a task, cancel one), applied and re-validated with no redraft; or amend with the whole plan." };
} else { console.error(`unknown kind ${kind}`); process.exit(2); }
console.log(JSON.stringify(out, null, 2));
