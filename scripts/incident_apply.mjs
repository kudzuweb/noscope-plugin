#!/usr/bin/env node
// Applies a validated object to incident.json and appends the events to log.jsonl beside it,
// so the session never edits state by hand. Run the validator on the object first.
//
//   node incident_apply.mjs command incident.json turn.json              the IC's command turn
//   node incident_apply.mjs plan    incident.json plan.json              an approved plan (after any patches)
//   node incident_apply.mjs assign  incident.json turn.json <unit-id>    a leader turn's assignTasks and consult
//   node incident_apply.mjs start   incident.json <task-id> [session-id] a task has started
//   node incident_apply.mjs ending  incident.json result.json <task-id>  a task's result (a session result, or {output, measure} from incident_evidence.mjs)
//   node incident_apply.mjs report  incident.json turn.json <unit-id>    a leader's report turn (kind report)
//   node incident_apply.mjs heard   incident.json <unit-id> <task-id>... the leader was given these endings
//   node incident_apply.mjs answer  incident.json <question-id> "<text>" the human's answer
//   node incident_apply.mjs briefing incident.json briefing.json         the size-up's IncidentBriefing: seeds the situation, keeps its questions for the first turn
//   node incident_apply.mjs call    incident.json <seat> <model> <in> <out> <seconds> [costUsd|""] [id] [cacheRead] [cacheWrite5m] [cacheWrite1h] [toolCalls-json]  one model call, priced at list if no cost is given
//   node incident_apply.mjs handoff incident.json handoff.json [successor-name]  a validated HandoffDocument: command is transferred
//   node incident_apply.mjs run     incident.json <key> <json-value>      one field of run.json; the key must be one it has, and the script lists them when it is not
//   node incident_apply.mjs review  incident.json review.json draft.json  the IC's ReviewTurn: logs the verdict; correct applies the patches to the draft
//                                                                         and amend replaces it, writing the plan to apply over draft.json (validate it again)
//   node incident_apply.mjs rejected incident.json <kind> <reasons.txt|-> [id]  a validator's REJECT lines on a plan, command, leader, result, briefing or review, logged
//   node incident_apply.mjs config  incident.json <name> <unit-id>        save the unit's filled form as a config, in the state and in ~/.claude/noscope/configs.json
//   node incident_apply.mjs stop    incident.json "<why>"                 the human stops the run: status stopped, run paused with the why; only /noscope-resume reopens it
//   node incident_apply.mjs budget  incident.json <tokens|seconds> <n|none>  the human sets, raises or lifts the incident's bound mid-run
//
// Prints what changed, one line each. Ids are <incident>- uNN units, tNN tasks, cNN claims,
// rNN reassignments, oNN open items, qNN questions, pNN reports, gNN resource gaps.
import { loadState, saveState, appendLog, nextId, OPEN_TASK, isDeterministic, rootUnit, refreshReady, cascadeCancel, measureOf, priceOf, loadRun, saveRun, loadSavedConfigs, saveSavedConfigs, resolveModel, runConfig, clearSessions } from "./incident_lib.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const [mode, statePath, a, b, ...rest] = process.argv.slice(2);
if (!mode || !statePath) { console.error("usage: see the header of incident_apply.mjs"); process.exit(2); }
const state = loadState(statePath);
const events = [];
const said = [];
const say = (s) => said.push(s);
const now = () => new Date().toISOString();
const json = (p) => JSON.parse(readFileSync(p, "utf8"));
/** One line, so the record stays readable; the body is a file away. */
const clipLine = (s, n = 280) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n - 1) + "\u2026" : t; };

/** The end of a run closes every unit still active and cancels every open task, so nothing is left running in the record; the IC tells each leader session to close. */
function closeAllUnits(reason, actor) {
  const root = rootUnit(state);
  for (const u of state.units) if (u.status !== "closed" && u.id !== root?.id) { u.status = "closed"; u.closedBecause = reason; events.push({ type: "unit.closed", actor, unitId: u.id, reason }); say(`unit ${u.id} closed: ${reason}`); }
  for (const t of state.tasks) if (OPEN_TASK.has(t.status)) { t.status = "cancelled"; t.reason = reason; events.push({ type: "task.cancelled", actor, taskId: t.id, reason }); say(`task ${t.id} cancelled: ${reason}`); }
}
function createTasks(proposals, { unitOf, refIds, actor }) {
  const made = [];
  for (const p of proposals) {
    const id = nextId(state, state.tasks, "t");
    if (p.ref) refIds.set(p.ref, id);
    const t = {
      id, unitId: unitOf(p.unit), resource: p.resource, objective: p.objective, scope: p.scope ?? null, inputs: p.inputs ?? {},
      expectedOutput: p.expectedOutput ?? "", completionCriteria: p.completionCriteria ?? [], evidenceRequired: p.evidenceRequired ?? [],
      dependsOn: [], evidenceFrom: { claims: p.evidenceFrom?.claims ?? [], tasks: [] }, settles: p.settles ?? [], instructions: p.instructions ?? "",
      provider: p.provider ?? null, model: p.model ?? null, modelWhy: p.modelWhy, budget: p.budget ?? {}, strikeTeam: p.strikeTeam, status: "pending", heard: true, createdBy: actor,
    };
    state.tasks.push(t); made.push([t, p]);
  }
  for (const [t, p] of made) {
    t.dependsOn = (p.dependsOn ?? []).map((d) => refIds.get(d) ?? d);
    t.evidenceFrom.tasks = (p.evidenceFrom?.tasks ?? []).map((d) => refIds.get(d) ?? d);
    events.push({ type: "task.created", actor, taskId: t.id, unitId: t.unitId, resource: t.resource });
    say(`task ${t.id} [${t.resource}] under ${t.unitId}: ${t.objective}`);
  }
  refreshReady(state);
  return made.map(([t]) => t);
}

function closeUnit(id, reason, actor) {
  const u = state.units.find((x) => x.id === id); if (!u) return;
  u.status = "closed"; u.closedWhy = reason; u.sessionId = null;
  events.push({ type: "unit.closed", actor, unitId: id, reason });
  say(`unit ${id} closed: ${reason}`);
}

function cancelTask(id, reason, actor) {
  const t = state.tasks.find((x) => x.id === id); if (!t || !["pending", "ready"].includes(t.status)) return;
  t.status = "cancelled"; t.reason = reason;
  events.push({ type: "task.cancelled", actor, taskId: id, reason });
  say(`task ${id} cancelled: ${reason}`);
  for (const c of cascadeCancel(state, id, "was cancelled")) { events.push({ type: "task.cancelled", actor: "runtime", taskId: c, because: id, reason: state.tasks.find((x) => x.id === c).reason }); say(`task ${c} cancelled because it waited on ${id}`); }
}

if (mode === "command") {
  const t = json(a); const actor = "ic"; const root = rootUnit(state);
  state.period = { number: (state.period?.number ?? 0) + 1, objectives: t.periodObjectives, priorities: t.priorities };
  // situation: number new open items, keep carried ids
  const s = structuredClone(t.situation ?? {});
  const used = new Set([...(state.situation?.open ?? []), ...(state.openItemsEver ?? [])].map((o) => o.id ?? o).filter(Boolean));
  s.open = (s.open ?? []).map((o) => {
    if (o.id) return o;
    const id = nextId({ incident: state.incident }, [...used].map((x) => ({ id: x })), "o");
    used.add(id); return { ...o, id };
  });
  state.openItemsEver = [...used];
  state.situation = s;
  events.push({ type: "command.turned", actor, period: state.period.number, objectives: t.periodObjectives, priorities: t.priorities, situation: s, incidentStatus: t.incidentStatus });
  say(`period ${state.period.number}: ${t.periodObjectives.length} objective(s); assessment ${s.assessment?.kind ?? "(none)"}; open items ${s.open.map((o) => o.id).join(", ") || "(none)"}`);
  // briefing questions on the first turn
  for (const r of t.briefingQuestions ?? []) {
    const text = state.briefing?.questions?.[r.proposal - 1];
    if (r.verdict === "accept") { const id = nextId(state, state.questions, "q"); state.questions.push({ id, text, askedBy: "ic", proposal: r.proposal }); events.push({ type: "question.asked", actor, questionId: id, text }); say(`question ${id} asked (accepted proposal ${r.proposal}): ${text}`); }
    else if (r.verdict === "answer") { const id = nextId(state, state.questions, "q"); state.questions.push({ id, text, askedBy: "ic", proposal: r.proposal, answer: r.answer, answeredBy: "ic" }); events.push({ type: "question.answered", actor, questionId: id, answer: r.answer, why: r.why }); say(`proposal ${r.proposal} answered by the IC: ${r.answer}`); }
    else { events.push({ type: "proposal.discarded", actor, proposal: r.proposal, why: r.why }); say(`proposal ${r.proposal} discarded: ${r.why}`); }
  }
  for (const q of t.questionsForHuman ?? []) { const id = nextId(state, state.questions, "q"); state.questions.push({ id, text: q, askedBy: "ic" }); events.push({ type: "question.asked", actor, questionId: id, text: q }); say(`question ${id} asked: ${q}`); }
  // verdicts
  for (const v of t.reportVerdicts ?? []) {
    const r = state.reports.find((x) => x.id === v.reportId); if (!r) continue;
    r.verdict = v.verdict; r.verdictWhy = v.why; r.instructions = v.instructions;
    const u = state.units.find((x) => x.id === v.unitId); if (u) u.lastVerdict = v.verdict;
    events.push({ type: "report.reviewed", actor, reportId: r.id, unitId: v.unitId, verdict: v.verdict, why: v.why, instructions: v.instructions });
    say(`report ${r.id} of ${v.unitId}: ${v.verdict}`);
    if (v.verdict === "accepted") closeUnit(v.unitId, "accepted", actor);
    if (v.verdict === "revise") { if (u) { u.revisePending = true; u.reviseInstructions = v.instructions; u.reviseWhy = v.why; u.reviseReportId = r.id; } }
    if (v.verdict === "reassign") {
      const unitTasks = state.tasks.filter((x) => x.unitId === v.unitId);
      const claims = state.claims.filter((c) => unitTasks.some((x) => x.id === c.provenance?.taskId)).map((c) => c.id);
      for (const x of unitTasks) if (["pending", "ready"].includes(x.status)) cancelTask(x.id, `reassign: ${v.why}`, actor);
      const id = nextId(state, state.reassignments, "r");
      const dropped = /^drop:/i.test(v.instructions ?? "");
      state.reassignments.push({ id, unitId: v.unitId, objective: u?.objective, reportId: r.id, instructions: v.instructions, why: v.why, claims, status: dropped ? "dropped" : "open" });
      events.push({ type: "unit.reassigned", actor, reassignmentId: id, unitId: v.unitId, instructions: v.instructions, claims, dropped });
      say(`reassignment ${id} recorded from ${v.unitId} (${dropped ? "dropped" : "open"}), carrying ${claims.length} claim(s)`);
      closeUnit(v.unitId, "reassigned", actor);
    }
  }
  for (const d of t.dropReassignments ?? []) { const r = state.reassignments.find((x) => x.id === d.id); if (r) { r.status = "dropped"; r.droppedWhy = d.why; events.push({ type: "reassignment.dropped", actor, reassignmentId: d.id, why: d.why }); say(`reassignment ${d.id} dropped: ${d.why}`); } }
  for (const c of t.closeUnits ?? []) closeUnit(c.unitId ?? c, c.reason ?? "closed by the IC", actor);
  if ((t.assignTasks ?? []).length) createTasks(t.assignTasks, { unitOf: () => root.id, refIds: new Map(), actor });
  state.incident.status = t.incidentStatus === "continue" ? (state.questions.some((q) => !q.answer) ? "blocked" : "open") : t.incidentStatus;
  events.push({ type: "incident.status", actor, status: state.incident.status });
  if (["satisfied", "failed"].includes(state.incident.status)) closeAllUnits(`the incident is ${state.incident.status}`, actor);
  say(`incident ${state.incident.status}`);
}
else if (mode === "plan") {
  const p = json(a); const actor = "planner";
  const unitIds = new Map();
  for (const u of p.createUnits ?? []) {
    const id = nextId(state, state.units, "u"); unitIds.set(u.ref, id);
    const cfg = u.config ? (state.configs ?? []).find((c) => c.name === u.config) : null;
    const unit = { id, parentId: unitIds.get(u.parent) ?? u.parent, type: u.type ?? "base", config: u.config ?? null, objective: u.objective, scope: u.scope ?? null, leader: u.leader ?? cfg?.leader, resourcesAssigned: u.resourcesAssigned ?? cfg?.resourcesAssigned ?? [], bashAllowlist: u.bashAllowlist ?? cfg?.bashAllowlist ?? [], role: u.role ?? cfg?.role ?? null, status: "active", revisePending: false, sessionId: null };
    state.units.push(unit);
    // A configured leader model overrides the plan's; "smallest" leaves the plan's choice.
    const fixedLeader = resolveModel("leader", runConfig(statePath));
    if (fixedLeader && unit.leader && unit.leader.model !== fixedLeader) { events.push({ type: "unit.leader.routed", actor, unitId: id, from: unit.leader.model, to: fixedLeader }); unit.leader = { ...unit.leader, model: fixedLeader }; }
    events.push({ type: "unit.created", actor, unitId: id, parentId: unit.parentId, objective: u.objective, scope: unit.scope, leader: unit.leader });
    say(`unit ${id} under ${unit.parentId} (${unit.leader?.model ?? "?"}): ${u.objective}`);
    if (u.takes) { const r = state.reassignments.find((x) => x.id === u.takes); if (r) { r.status = "taken"; r.takenBy = id; unit.takes = u.takes; events.push({ type: "reassignment.taken", actor, reassignmentId: u.takes, unitId: id }); say(`reassignment ${u.takes} taken by ${id}`); } }
  }
  for (const c of p.cancelTasks ?? []) cancelTask(c, "cancelled by the plan", actor);
  for (const c of p.closeUnits ?? []) closeUnit(c.unitId ?? c, c.reason ?? "closed by the plan", actor);
  createTasks(p.createTasks ?? [], { unitOf: (u) => unitIds.get(u) ?? u, refIds: new Map(), actor });
  events.push({ type: "plan.applied", actor, units: (p.createUnits ?? []).length, tasks: (p.createTasks ?? []).length, rationale: p.rationale });
  if (p.incidentStatus && p.incidentStatus !== "continue") { state.incident.status = p.incidentStatus; events.push({ type: "incident.status", actor, status: p.incidentStatus }); say(`incident ${p.incidentStatus}`); }
}
else if (mode === "assign") {
  const t = json(a); const unitId = b;
  const refIds = new Map();
  const made = createTasks(t.assignTasks ?? [], { unitOf: () => unitId, refIds, actor: `leader:${unitId}` });
  for (const c of t.consult ?? []) { const id = refIds.get(c) ?? c; const task = state.tasks.find((x) => x.id === id); if (task) { task.consult = true; say(`consult flagged on ${id}`); } }
  events.push({ type: "unit.continued", actor: `leader:${unitId}`, unitId, assigned: made.map((x) => x.id), consult: t.consult ?? [] });
}
else if (mode === "start") {
  const t = state.tasks.find((x) => x.id === a); if (!t) { console.error(`no task ${a}`); process.exit(1); }
  t.status = "running"; t.startedAt = now(); t.sessionId = b ?? null;
  events.push({ type: "task.started", actor: "runtime", taskId: t.id, sessionId: t.sessionId });
  say(`task ${t.id} running`);
}
else if (mode === "ending") {
  const r = json(a); const t = state.tasks.find((x) => x.id === b); if (!t) { console.error(`no task ${b}`); process.exit(1); }
  // Where the seat's own object is, so the record can point at the body instead of holding it.
  const resultBody = resolve(a);
  // A task ends once. A seat resumed by a later message stops again, and its stop hook would
  // apply the same result twice, doubling its claims (seen 2026-09-21); the second ending is refused.
  if (!OPEN_TASK.has(t.status)) { console.error(`task ${t.id} already ended (${t.status}); nothing applied`); process.exit(1); }
  const actor = `task:${t.id}`;
  t.endedAt = now(); t.heard = false;
  if (isDeterministic(state, t.resource)) {
    const output = r.output ?? r; const measure = r.measure ?? measureOf(t.resource, output);
    if (r.error) { t.status = "failed"; t.reason = r.error; events.push({ type: "task.failed", actor, taskId: t.id, reason: r.error }); say(`task ${t.id} failed: ${r.error}`); }
    else {
      // The measure and where the output is, not the output. A tool's output is the largest
      // thing in a run — one file read carried 141K of file content in the record and went to
      // the planner every period after — and the session that ran the tool has already seen it.
      // A brief that attaches this evidence reads the body from the file, so nothing is lost.
      t.status = "completed"; t.result = { measure, body: resultBody }; t.measure = measure;
      state.evidence.push({ taskId: t.id, resource: t.resource, inputs: t.inputs, measure, body: resultBody });
      events.push({ type: "task.completed", actor, taskId: t.id, evidence: measure });
      say(`task ${t.id} completed; evidence: ${measure}`);
    }
  } else if (r.error || r.refusals) {
    t.status = "failed"; t.reason = r.error ?? "refused twice"; t.refusals = r.refusals; events.push({ type: "task.failed", actor, taskId: t.id, reason: t.reason, refusals: r.refusals }); say(`task ${t.id} failed: ${t.reason}`);
  } else if (r.outcome === "insufficient") {
    t.status = "insufficient"; t.needed = r.needed ?? []; t.result = { outcome: r.outcome, summary: clipLine(r.summary ?? r.findings?.summary), body: resultBody }; events.push({ type: "task.insufficient", actor, taskId: t.id, needed: t.needed }); say(`task ${t.id} insufficient: ${(t.needed ?? []).map((n) => n.kind).join(", ")}`);
  } else {
    // What the record keeps of a session task is a line: the outcome, one summary, and where the
    // seat's own object is. The body stays in that file, which the seat hook already wrote, and
    // in the subagent's transcript. Keeping it here too put one reproduce task's 141K of
    // observations into incident.json and shipped it to the planner every period afterwards,
    // for claims that had already been extracted out of it.
    t.status = "completed";
    t.result = { outcome: r.outcome, summary: clipLine(r.summary ?? r.findings?.summary), body: resultBody };
    if (r.pictureChanged) t.pictureChanged = true;
    const attached = new Set((t.evidenceFrom?.tasks ?? []).filter((id) => { const d = state.tasks.find((x) => x.id === id); return d?.status === "completed" && isDeterministic(state, d.resource); }));
    const ids = [];
    for (const c of r.claims ?? []) {
      const id = nextId(state, state.claims, "c");
      const cites = c.cites ?? [];
      const basis = cites.length > 0 && !cites.every((x) => attached.has(x)) ? "inferred" : c.basis;
      state.claims.push({ id, subject: c.subject, predicate: c.predicate, object: c.object ?? null, basis, confidence: c.confidence, status: "asserted", provenance: { taskId: t.id, sessionId: t.sessionId ?? null, cites } });
      ids.push(id);
    }
    events.push({ type: "task.completed", actor, taskId: t.id, claims: ids, summary: t.result.summary, pictureChanged: !!r.pictureChanged });
    say(`task ${t.id} completed; ${ids.length} claim(s)${ids.length ? ": " + ids.join(", ") : ""}`);
  }
  if (t.status !== "completed") for (const c of cascadeCancel(state, t.id, t.status === "failed" ? "failed" : "came back insufficient")) { events.push({ type: "task.cancelled", actor: "runtime", taskId: c, because: t.id, reason: state.tasks.find((x) => x.id === c).reason }); say(`task ${c} cancelled because it waited on ${t.id}`); }
  refreshReady(state);
}
else if (mode === "report") {
  const turn = json(a); const unitId = b; const r = turn.report; const u = state.units.find((x) => x.id === unitId);
  if (!r || !u) { console.error("a report turn for an existing unit is needed"); process.exit(1); }
  const id = nextId(state, state.reports, "p");
  const revision = u.revisePending ? (u.revisions ?? 0) + 1 : (u.revisions ?? 0);
  if (u.revisePending) { u.revisePending = false; u.revisions = revision; events.push({ type: "unit.revised", actor: `leader:${unitId}`, unitId, reportId: u.reviseReportId }); }
  state.reports.push({ id, unitId, outcome: r.outcome, pictureChanged: r.pictureChanged, changes: r.changes ?? [], why: r.why, suggestion: r.suggestion, situation: r.situation, revision, at: now() });
  u.lastPicture = r.situation;
  for (const t of state.tasks) if (t.unitId === unitId) t.heard = true;
  events.push({ type: "unit.reported", actor: `leader:${unitId}`, unitId, reportId: id, outcome: r.outcome, pictureChanged: r.pictureChanged, revision });
  say(`report ${id} from ${unitId}: ${r.outcome}${r.pictureChanged ? ", picture changed" : ""}${revision ? ` (revision ${revision})` : ""}`);
  // Resource requests: what the unit lacks and cannot get inside itself. A retrievable fact is
  // never one (the leader assigns a task); the other kinds go up and the unit waits.
  for (const rr of r.resourceRequests ?? []) {
    if (rr.kind === "missing_means") {
      const cid = nextId(state, state.resourceGaps ??= [], "g");
      state.resourceGaps.push({ id: cid, unitId, reportId: id, need: rr.what, why: rr.why, at: now() });
      events.push({ type: "resource.gap", actor: `leader:${unitId}`, unitId, requestId: cid, need: rr.what, why: rr.why });
      say(`resource gap ${cid} from ${unitId}: ${rr.what}`);
    } else {
      const qid = nextId(state, state.questions, "q");
      state.questions.push({ id: qid, text: rr.what, why: rr.why, kind: rr.kind, askedBy: `leader:${unitId}`, unitId, reportId: id });
      events.push({ type: "question.asked", actor: `leader:${unitId}`, questionId: qid, unitId, kind: rr.kind, text: rr.what });
      say(`question ${qid} from ${unitId} (${rr.kind}): ${rr.what}`);
    }
    state.reports.at(-1).pictureChanged = true;
    u.status = "waiting"; u.waitsOn = rr.what;
  }
  if (u.status === "waiting") { events.push({ type: "unit.waiting", actor: `leader:${unitId}`, unitId, on: u.waitsOn }); say(`unit ${unitId} waits on: ${u.waitsOn}`); }
  if ((turn.assignTasks ?? []).length) createTasks(turn.assignTasks, { unitOf: () => unitId, refIds: new Map(), actor: `leader:${unitId}` });
}
else if (mode === "heard") {
  const unitId = a; const ids = [b, ...rest].filter(Boolean);
  for (const t of state.tasks) if (t.unitId === unitId && (ids.length === 0 || ids.includes(t.id))) t.heard = true;
  events.push({ type: "unit.heard", actor: "runtime", unitId, taskIds: ids });
  say(`${unitId} heard ${ids.join(", ") || "every ending"}`);
}
else if (mode === "answer") {
  const q = state.questions.find((x) => x.id === a); if (!q) { console.error(`no question ${a}`); process.exit(1); }
  q.answer = b; q.answeredBy = "human";
  events.push({ type: "question.answered", actor: "human", questionId: q.id, answer: b });
  if (q.unitId) { const u = state.units.find((x) => x.id === q.unitId); if (u && u.status === "waiting" && !state.questions.some((x) => x.unitId === u.id && !x.answer)) { u.status = "active"; delete u.waitsOn; events.push({ type: "unit.resumed", actor: "human", unitId: u.id }); say(`unit ${u.id} active again`); } }
  if (!state.questions.some((x) => !x.answer) && state.incident.status === "blocked") { state.incident.status = "open"; events.push({ type: "incident.status", actor: "runtime", status: "open" }); }
  say(`question ${q.id} answered; incident ${state.incident.status}`);
}
else if (mode === "briefing") {
  const b = json(a);
  state.briefing = { kind: b.kind, questions: b.questionsForHuman ?? [], initialObjectives: b.initialObjectives ?? [], initialOrganization: b.initialOrganization ?? [], hazards: b.hazards ?? [] };
  state.situation = {
    picture: b.dominantProblem ?? "",
    evidence: [],
    open: (b.obviouslyNeeded ?? []).filter((n) => !n.checked).map((n) => ({ what: n.what, settledBy: "a task that checks it" })),
    assessment: { kind: "on_track", why: "seeded from the size-up; nothing observed yet" },
    changed: "Seeded from the initial IC's briefing.",
  };
  events.push({ type: "command.transferred", actor: "initial_ic", from: "initial_ic", briefing: b });
  say(`briefing taken: ${b.kind}; ${state.briefing.questions.length} question(s) proposed; ${state.situation.open.length} open item(s) seeded`);
  // Seats configured "smallest" take the size-up's judgment of the right-sized model for that role for this incident.
  const run = loadRun(statePath);
  if (run?.models) {
    const judged = { ic: b.incomingCommander?.model, planner: b.seatModels?.planner?.model, leader: b.seatModels?.leader?.model };
    let changed = false;
    for (const seat of ["ic", "planner", "leader"]) if (run.models[seat] === "smallest" && judged[seat]) { run.models[seat] = judged[seat]; changed = true; events.push({ type: "model.routed", actor: "initial_ic", seat, model: judged[seat], why: seat === "ic" ? b.incomingCommander?.why : b.seatModels?.[seat]?.why }); say(`${seat} routed to ${judged[seat]} (right-sized for this incident)`); }
    if (changed) saveRun(statePath, run);
    const root = rootUnit(state); if (root && root.leader?.model === "smallest") root.leader.model = run.models.ic;
  }
}
else if (mode === "call") {
  const [seat, model, inTok, outTok, seconds, cost, id, cRead, cW5, cW1, tools] = [a, b, ...rest];
  if (!seat || !model) { console.error("call needs <seat> <model> <in> <out> <seconds> [costUsd] [id] [cacheRead] [cacheWrite5m] [cacheWrite1h]"); process.exit(2); }
  const inputTokens = Number(inTok ?? 0), outputTokens = Number(outTok ?? 0), secs = Number(seconds ?? 0);
  const cache = { read: Number(cRead ?? 0), write5m: Number(cW5 ?? 0), write1h: Number(cW1 ?? 0) };
  const costUsd = cost !== undefined && cost !== "" ? Number(cost) : priceOf(model, inputTokens, outputTokens, cache);
  const allIn = inputTokens + cache.read + cache.write5m + cache.write1h;
  state.incident.spent = { tokens: (state.incident.spent?.tokens ?? 0) + allIn + outputTokens, seconds: (state.incident.spent?.seconds ?? 0) + secs, costUsd: Number(((state.incident.spent?.costUsd ?? 0) + (costUsd ?? 0)).toFixed(4)) };
  let toolCalls = null; try { toolCalls = tools ? JSON.parse(tools) : null; } catch { toolCalls = null; }
  events.push({ type: "call", actor: seat, seat, model, inputTokens, outputTokens, cache, seconds: secs, costUsd, id: id && id !== "" ? id : null, ...(toolCalls ? { toolCalls } : {}) });
  say(`call ${seat} ${model}: in ${inputTokens}, out ${outputTokens}, ${secs} s, ${costUsd === null ? "unpriced (model not in the price table)" : "$" + costUsd.toFixed(4)}`);
}
else if (mode === "handoff") {
  const h = json(a);
  events.push({ type: "command.transferred", actor: "ic", from: "ic", to: b ?? null, handoff: h });
  say(`command transferred${b ? " to " + b : ""}: period ${state.period.number}, ${h.units?.length ?? 0} unit(s) described, next move: ${String(h.nextMove ?? "").slice(0, 80)}`);
}
else if (mode === "run") {
  const run = loadRun(statePath); if (!run) { console.error("no run.json beside incident.json"); process.exit(1); }
  // Only the fields run.json has. Any key was accepted before, so `icSesion` was written, the
  // command said it had worked, and icSession stayed unset — and a leader addresses the IC by
  // that field, so the incident went on with nobody named where its seats look.
  const SETTABLE = ["mode", "attended", "cutoffAt", "paused", "stoppedAt", "icSession", "sessions", "heartbeat.cronId", "heartbeat.everyMinutes", "models.ic", "models.leader", "models.planner"];
  if (!SETTABLE.includes(a)) { console.error(`run.json has no field "${a}"; it is one of: ${SETTABLE.join(", ")}`); process.exit(2); }
  let value; try { value = JSON.parse(b); } catch { value = b; }
  const path = a.split("."); let o = run; for (const k of path.slice(0, -1)) o = (o[k] ??= {}); o[path.at(-1)] = value;
  saveRun(statePath, run);
  events.push({ type: "run.updated", actor: "ic", key: a, value });
  say(`run.${a} = ${JSON.stringify(value)}`);
}
else if (mode === "review") {
  const review = json(a); const draftPath = b; const draft = json(draftPath);
  const reasons = [];
  const indexOf = (ref) => { if (!ref) return -1; const m = /^#(\d+)$/.exec(ref); if (m) return Number(m[1]) - 1 < (draft.createTasks ?? []).length ? Number(m[1]) - 1 : -1; return (draft.createTasks ?? []).findIndex((t) => t.ref === ref); };
  let plan = draft;
  if (review.verdict === "correct") {
    plan = structuredClone(draft); plan.createTasks ??= []; plan.cancelTasks ??= [];
    const original = draft.createTasks ?? []; const removed = new Set();
    for (const [n, p] of (review.patches ?? []).entries()) {
      const at = `patch ${n + 1} (${p.kind}${p.task ? " " + p.task : ""})`;
      if (p.kind === "set") {
        const i = indexOf(p.task); if (i < 0) { reasons.push(`${at} names no task of the draft`); continue; }
        if (removed.has(i)) { reasons.push(`${at} sets a field on a task an earlier patch cancelled`); continue; }
        if (!p.field) { reasons.push(`${at} names no field`); continue; }
        plan.createTasks[i][p.field] = p.value;   // adds append after the draft's tasks, so draft positions hold
      } else if (p.kind === "add") {
        if (!p.proposal) { reasons.push(`${at} carries no proposal`); continue; }
        plan.createTasks.push(p.proposal);
      } else if (p.kind === "cancel") {
        const i = indexOf(p.task);
        if (i >= 0) removed.add(i);
        else if (state.tasks.some((t) => t.id === p.task && OPEN_TASK.has(t.status))) { if (!plan.cancelTasks.includes(p.task)) plan.cancelTasks.push(p.task); }
        else reasons.push(`${at} names neither a draft task nor an open task`);
      } else reasons.push(`${at}: unknown kind`);
    }
    plan.createTasks = plan.createTasks.filter((t, i) => !(i < original.length && removed.has(i)));
  } else if (review.verdict === "amend") {
    if (!review.plan) reasons.push("an amend carries the whole plan under \"plan\""); else plan = review.plan;
  }
  events.push({ type: "plan.reviewed", actor: "ic", period: state.period.number, verdict: review.verdict, patches: review.patches ?? [], reasons, rationale: review.rationale ?? null });
  if (reasons.length) { for (const r of reasons) console.error(`REJECT Patch applies: ${r}`); saveState(statePath, state); appendLog(statePath, events); process.exit(1); }
  if (review.verdict !== "approve") writeFileSync(draftPath, JSON.stringify(plan, null, 2) + "\n");
  say(`review: ${review.verdict}${review.verdict === "correct" ? `, ${(review.patches ?? []).length} patch(es) applied to ${draftPath}; validate it again` : review.verdict === "amend" ? `, the amended plan written to ${draftPath}; validate it again` : ""}`);
}
else if (mode === "rejected") {
  const kind = a; const text = b === "-" ? readFileSync(0, "utf8") : readFileSync(b, "utf8");
  // Validator lines start with REJECT; a hook's own reason (no object returned, a missing id) does not, and counts too.
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const reasons = lines.some((l) => l.startsWith("REJECT")) ? lines.filter((l) => l.startsWith("REJECT")) : lines.slice(0, 3).map((l) => `REJECT shape: ${l}`);
  if (!reasons.length) { say("no REJECT lines; nothing logged"); }
  else { events.push({ type: `${kind}.rejected`, actor: kind === "command" || kind === "review" ? "ic" : kind === "leader" ? "leader" : kind === "result" ? "task" : kind === "briefing" ? "initial_ic" : "planner", period: state.period.number, id: rest[0] ?? null, reasons }); say(`${kind} rejected: ${reasons.length} reason(s) logged`); }
}
else if (mode === "config") {
  const name = a; const u = state.units.find((x) => x.id === b); if (!name || !u) { console.error("config needs <name> <unit-id>"); process.exit(2); }
  const form = { name, type: u.type ?? "base", leader: u.leader, resourcesAssigned: u.resourcesAssigned ?? [], bashAllowlist: u.bashAllowlist ?? [], role: u.role ?? null, savedFrom: { incident: state.incident.id, unit: u.id, objective: u.objective }, at: now() };
  state.configs = (state.configs ?? []).filter((c) => c.name !== name); state.configs.push(form);
  const saved = loadSavedConfigs().filter((c) => c.name !== name); saved.push(form); saveSavedConfigs(saved);
  events.push({ type: "config.saved", actor: "ic", name, unitId: u.id });
  say(`config "${name}" saved from ${u.id} (${form.leader?.model}; ${form.resourcesAssigned.join(", ") || "no resources assigned"}); available to every later incident`);
}
else if (mode === "budget") {
  // The bound is the human's to set whenever she decides the run should have one, not only when
  // the incident opens. incident_next.mjs blocks every new task once it is spent and tells the
  // commander the human may raise it, so without this that instruction named nothing.
  const dim = a;
  if (!["tokens", "seconds"].includes(dim)) { console.error("budget needs tokens or seconds"); process.exit(2); }
  state.incident.budget ??= {};
  const spent = state.incident.spent?.[dim] ?? 0;
  if (b === "none") {
    delete state.incident.budget[dim];
    events.push({ type: "incident.budget", actor: "human", dimension: dim, value: null });
    say(`the ${dim} bound is lifted; ${spent} spent so far and nothing blocks on it`);
  } else {
    const n = Number(b);
    if (!Number.isFinite(n) || n <= 0) { console.error("budget needs a positive number, or none to lift it"); process.exit(2); }
    state.incident.budget[dim] = n;
    events.push({ type: "incident.budget", actor: "human", dimension: dim, value: n });
    say(`the ${dim} bound is ${n}; ${spent} already spent, ${n - spent} left${n - spent <= 0 ? " — the next pass starts nothing until it is raised" : ""}`);
  }
}
else if (mode === "stop") {
  const why = a ?? "stopped by the human";
  state.incident.status = "stopped";
  closeAllUnits(`the run was stopped: ${why}`, "human");
  const run = loadRun(statePath); if (run) { run.paused = why; run.stoppedAt = now(); saveRun(statePath, run); }
  events.push({ type: "incident.status", actor: "human", status: "stopped", why });
  say(`incident stopped: ${why}; /noscope-resume reopens it on purpose, /noscope-run starts a new one beside it`);
}
else { console.error(`unknown mode ${mode}`); process.exit(2); }

saveState(statePath, state);
appendLog(statePath, events);
// A finished record is inert: every session that was a seat of this run stops being one, so its
// hooks no longer fire wherever that session is still open. One place rather than one per
// ending, because satisfied, failed and stopped all arrive here.
if (["satisfied", "failed", "stopped"].includes(state.incident.status)) {
  const n = clearSessions(dirname(statePath));
  if (n) say(`${n} session(s) stood down; their noscope hooks no longer fire`);
  // Trust was lent for the length of the incident, so it goes back the moment the incident
  // ends. A repository an incident visited is left as it was found.
  try {
    const out = execFileSync("node", [join(dirname(fileURLToPath(import.meta.url)), "incident_trust.mjs"), "release", dirname(statePath)], { encoding: "utf8" }).trim();
    if (out && !out.startsWith("nothing was lent")) say(`trust: ${out}`);
  } catch {}
}
if (mode === "command") { const d = join(dirname(statePath), "hooks"); mkdirSync(d, { recursive: true }); writeFileSync(join(d, "state-at-turn.json"), JSON.stringify(state)); }
for (const s of said) console.log(s);
