#!/usr/bin/env node
// The checklist as a tool call. Checks a planner's draft or an IC's command turn against the
// incident state and prints every rule it breaks, so the session spends no model call on what
// a rule can decide.
//
//   node incident_validator.mjs plan    incident.json draft.json   [working-directory]   a planner's draft
//   node incident_validator.mjs command incident.json turn.json    [working-directory]   the IC's command turn
//   node incident_validator.mjs leader  incident.json turn.json    <unit-id>             a unit leader's turn
//   node incident_validator.mjs result  incident.json result.json  <task-id>             a task session's result
//   node incident_validator.mjs briefing incident.json briefing.json                     the size-up's briefing
//   node incident_validator.mjs review  incident.json review.json  <draft.json>          the IC's review of a draft
//   node incident_validator.mjs handoff incident.json handoff.json                       an outgoing IC's handoff
//   node incident_validator.mjs brief   incident.json brief.json    <kind> [id]          a brief you send down, before you send it:
//                                        kind is orientation|turn (id: the unit), task (id: the task), planner, sizeup
//
// Any seat runs the mode for the object it is about to return, and fixes what is rejected
// before returning it. Prints one line per finding: `REJECT <rule>: <reason>` or `WARN <rule>:
// <reason>`, each naming the task, field or id concerned. Exits 1 when anything is rejected, 0
// otherwise; warnings never fail the check, they are read at review. The rules are the ones in
// the protocol's checklist section; the state shape is the one "What you keep" describes (see
// state.example.json beside this file). No dependencies.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const [mode, statePath, draftPath, extra] = process.argv.slice(2);
const [, , , , idArg] = process.argv.slice(2);
if (!["plan", "command", "leader", "result", "briefing", "review", "handoff", "brief"].includes(mode) || !statePath || !draftPath) {
  console.error("usage: incident_validator.mjs plan|command|leader|result|briefing|review|handoff|brief incident.json <object>.json [working-directory | unit-id | task-id | draft.json | kind id]");
  process.exit(2);
}
const state = JSON.parse(readFileSync(statePath, "utf8"));
const draft = JSON.parse(readFileSync(draftPath, "utf8"));
const cwd = (mode === "plan" || mode === "command" ? extra : undefined) ?? state.incident?.workingDirectory ?? process.cwd();

const rejects = [];
const KNOWN_MODELS = ["claude-fable-5-1", "claude-opus-5", "claude-opus-4-8", "claude-sonnet-5", "claude-haiku-4-5"];
const STRIKE_MEMBER_MIN_TOKENS = 600;
const warns = [];
const reject = (rule, reason) => rejects.push(`REJECT ${rule}: ${reason}`);
const warn = (rule, reason) => warns.push(`WARN ${rule}: ${reason}`);

const caps = state.resources ?? {};
const units = state.units ?? [];
const tasks = state.tasks ?? [];
const claims = state.claims ?? [];
const openTaskStatuses = new Set(["pending", "ready", "running"]);
const unitById = new Map(units.map((u) => [u.id, u]));
const taskById = new Map(tasks.map((t) => [t.id, t]));
const claimIds = new Set(claims.map((c) => c.id));
const rootUnit = units.find((u) => u.parentId === null || u.parentId === undefined);
// A resource's kind, in NIMS's sense: equipment runs in process and always answers the same
// way, personnel is a session that judges. Everything the rules care about follows from it.
const isEquipment = (resource) => caps[resource]?.kind === "equipment";
const label = (t, i) => (t.ref ? `task ${t.ref}` : `task #${i + 1} ("${String(t.objective ?? "").slice(0, 60)}")`);
const largeModel = (m) => typeof m === "string" && /opus|fable/i.test(m);

// ---- Rules shared by a plan's tasks and a leader's or the IC's assignments ----------------
function checkTasks(proposals, { refsInPlan, unitsInPlan, cancelled, rule = "Fields complete" }) {
  proposals.forEach((t, i) => {
    const name = label(t, i);
    const cap = caps[t.resource];
    if (!t.resource || !cap) reject("Resource known", `${name} names resource "${t.resource}", which the registry lacks`);
    for (const f of ["objective", "expectedOutput"]) if (typeof t[f] !== "string" || t[f] === "") reject(rule, `${name} has no ${f}`);
    // Every sibling is shown this line and told to stay out of it, so a task without one leaves
    // its neighbours guessing where their own work ends.
    if (cap && !isEquipment(t.resource) && (typeof t.scope !== "string" || t.scope.trim() === ""))
      reject(rule, `${name} has no scope; one line naming the territory it owns, which its siblings are shown`);
    for (const f of ["completionCriteria", "evidenceRequired", "dependsOn"]) if (!Array.isArray(t[f])) reject(rule, `${name} has no ${f} list`);
    if (typeof t.inputs !== "object" || t.inputs === null) reject(rule, `${name} has no inputs object`);
    if (cap) {
      if (isEquipment(t.resource) && t.model) reject("Model known", `${name} is an equipment resource and names a model; only personnel names one`);
      if (!isEquipment(t.resource) && !t.model) reject("Model known", `${name} is a session task and names no model`);
      if (!isEquipment(t.resource) && largeModel(t.model) && !t.modelWhy)
        warn("Smallest model that fits", `${name} runs ${t.resource} on ${t.model} with no modelWhy; say why this task's work needs it, or name a smaller model`);
      if (!isEquipment(t.resource) && (t.budget?.seconds === undefined))
        reject("Budget respected", `${name} is a session task with no time bound (budget.seconds)`);
      if (isEquipment(t.resource) && !cap.pathsMayBeMissing && Array.isArray(cap.paths) && t.inputs) {
        for (const key of cap.paths) {
          const v = t.inputs[key];
          if (typeof v === "string" && !existsSync(resolve(cwd, v)))
            reject("Paths exist", `${name} names ${key} "${v}", which resolves against ${cwd} to nothing that exists`);
        }
      }
    }
    // the unit
    const unitOk = (t.unit && unitById.get(t.unit) && unitById.get(t.unit).status === "active") || unitsInPlan.has(t.unit);
    if (!unitOk) reject("Units exist", `${name} is under "${t.unit}", which is no active unit and no unit created in this plan`);
    // dependencies
    for (const d of t.dependsOn ?? []) {
      if (refsInPlan.has(d)) continue;
      const dep = taskById.get(d);
      if (!dep) reject("Dependencies resolve", `${name} depends on "${d}", which is no task id and no ref in this plan`);
      else if (!openTaskStatuses.has(dep.status) || cancelled.has(d))
        reject("Dependencies resolve", `${name} depends on ${d}, which is ${cancelled.has(d) ? "cancelled by this plan" : dep.status}`);
    }
    for (const c of t.evidenceFrom?.claims ?? []) if (!claimIds.has(c)) reject("Dependencies resolve", `${name} reads claim ${c}, which does not exist`);
    for (const e of t.evidenceFrom?.tasks ?? []) {
      const dep = taskById.get(e);
      if (!refsInPlan.has(e) && !dep) reject("Dependencies resolve", `${name} reads task "${e}", which does not exist`);
      else if (dep && dep.status !== "completed" && !(t.dependsOn ?? []).includes(e))
        reject("Dependencies resolve", `${name} reads task ${e} in evidenceFrom but does not depend on it, and it is not completed`);
    }
    for (const d of t.dependsOn ?? []) {
      if ((refsInPlan.has(d) || openTaskStatuses.has(taskById.get(d)?.status)) && !(t.evidenceFrom?.tasks ?? []).includes(d))
        warn("Independent work runs together", `${name} waits on ${d} but does not read its result; drop the dependsOn, name it in evidenceFrom.tasks, or say in the rationale why the order is needed`);
    }
    for (const s of t.settles ?? []) {
      const item = (state.situation?.open ?? []).find((o) => o.id === s);
      if (!item) reject("Open items are worked", `${name} settles "${s}", which is no open item of the situation`);
    }
    if (t.strikeTeam) {
      let members = 0;
      for (const k of t.strikeTeam) {
        if (!k.kind || !k.model || !k.prompt) reject(rule, `${name} declares a strike team kind without kind, model and prompt`);
        if (k.model && !KNOWN_MODELS.some((m) => String(k.model).includes(m))) reject("Model known", `${name}'s strike team kind "${k.kind}" names model ${k.model}; the provider serves ${KNOWN_MODELS.join(", ")}`);
        members += Number(k.count ?? 0);
      }
      // Each member spends at least STRIKE_MEMBER_MIN_TOKENS (a tool-less one-line member read 672 tokens on 2026-09-15), so the team's count fits the task's token bound.
      if (t.budget?.tokens !== undefined && members * STRIKE_MEMBER_MIN_TOKENS > t.budget.tokens) reject("Budget respected", `${name}'s strike team sends ${members} member(s), at least ${members * STRIKE_MEMBER_MIN_TOKENS} tokens, over the task's bound of ${t.budget.tokens}`);
    }
  });
}

// ---- A plan -------------------------------------------------------------------------------
function checkPlan(p) {
  const created = p.createUnits ?? [];
  const proposals = p.createTasks ?? [];
  const unitsInPlan = new Set(created.map((u) => u.ref));
  const refsInPlan = new Set(proposals.map((t) => t.ref).filter(Boolean));
  const cancelled = new Set(p.cancelTasks ?? []);
  const closes = p.closeUnits ?? [];

  created.forEach((u, i) => {
    const name = `unit ${u.ref ?? "#" + (i + 1)}`;
    if (!u.ref) reject("Fields complete", `${name} has no ref`);
    if (!u.objective) reject("Fields complete", `${name} has no objective`);
    // The same reason a task carries one, a level up: every other unit is shown this line, so a
    // unit without one leaves its neighbours guessing where their own ground ends, and two units
    // work the same territory without either noticing.
    if (typeof u.scope !== "string" || u.scope.trim() === "")
      reject("Fields complete", `${name} has no scope; one line naming the territory this unit covers, which the other units and the IC are shown`);
    const parentOk = (u.parent && unitById.get(u.parent)?.status === "active") || unitsInPlan.has(u.parent);
    if (!parentOk) reject("Units exist", `${name} has parent "${u.parent}", which is no active unit and no unit created in this plan`);
    if (u.config) {
      const cfg = (state.configs ?? []).find((c) => c.name === u.config);
      if (!cfg) reject("Config exists", `${name} names config "${u.config}", which is not saved`);
      else if (cfg.type && u.type && cfg.type !== u.type) reject("Config exists", `${name} names config "${u.config}" of type ${cfg.type} on a ${u.type} unit`);
    } else {
      for (const f of ["leader", "equipment", "bashAllowlist"]) if (u[f] === undefined) reject("Fields complete", `${name} names no config and leaves ${f} unfilled`);
      if (u.leader && (!u.leader.model || !u.leader.provider)) reject("Model known", `${name}'s leader names no provider and model`);
    }
    if (u.type && u.type !== "base") reject("Type exists", `${name} is of type ${u.type}; a plan may create base units only`);
    if (largeModel(u.leader?.model) && !u.modelWhy) warn("Smallest model that fits", `${name}'s leader is on ${u.leader.model} with no modelWhy; a leader directs and judges on Sonnet 5 when its briefs are specific, so say what about this unit's work makes the decomposition worth the larger model`);
    // A larger leader earns its price by dispatching cheaper workers. When its own tasks are as
    // large as it is, the upgrade buys nothing and costs on both sides, so the IC sees it at review.
    if (largeModel(u.leader?.model)) {
      const mine = proposals.filter((t2) => t2.unit === u.ref || t2.unit === u.id);
      const big = mine.filter((t2) => largeModel(t2.model));
      if (mine.length && big.length === mine.length)
        warn("Smallest model that fits", `${name} puts a ${u.leader.model} leader over ${mine.length} task(s) that are themselves on large models (${[...new Set(big.map((t2) => t2.model))].join(", ")}); a larger leader pays for itself by decomposing work onto smaller ones, so either drop the tasks to a smaller model or say in the rationale why this unit needs both`);
      if (mine.length && mine.length < 3)
        warn("Smallest model that fits", `${name} puts a ${u.leader.model} leader over only ${mine.length} task(s); a leader that makes few decisions has little to decompose, so consider Sonnet 5 unless the rationale says what this leader judges that a smaller one could not`);
    }
    if (u.takes) {
      const r = (state.reassignments ?? []).find((x) => x.id === u.takes);
      if (!r || r.status !== "open") reject("Reassignments taken", `${name} takes "${u.takes}", which is no open reassignment`);
    }
  });
  const takes = new Set(created.map((u) => u.takes).filter(Boolean));
  if (takes.size !== created.filter((u) => u.takes).length) reject("Reassignments taken", "two units take the same reassignment");
  for (const r of state.reassignments ?? []) {
    if (r.status === "open" && !takes.has(r.id) && p.incidentStatus !== "failed")
      reject("Reassignments taken", `reassignment ${r.id} (from unit ${r.unitId}) is open and no unit in this plan takes it; the IC drops it with a why or the plan takes it`);
  }

  checkTasks(proposals, { refsInPlan, unitsInPlan, cancelled });

  // open items worked: every undeferred open item is settled by a plan task or an open task
  const settledBy = new Set([...proposals.flatMap((t) => t.settles ?? []), ...tasks.filter((t) => openTaskStatuses.has(t.status) && !cancelled.has(t.id)).flatMap((t) => t.settles ?? [])]);
  for (const o of state.situation?.open ?? []) {
    if (o.id && !o.deferred && !settledBy.has(o.id))
      reject("Open items are worked", `open item ${o.id} ("${String(o.what ?? "").slice(0, 60)}") is settled by no task in this plan and no open task, and the IC did not defer it`);
  }

  // closing is clean
  for (const c of closes) {
    const u = unitById.get(c.unitId ?? c);
    const id = c.unitId ?? c;
    if (!u) { reject("Closing is clean", `closeUnits names "${id}", which is no unit`); continue; }
    if (u.status !== "active") reject("Closing is clean", `unit ${id} is ${u.status}, not active`);
    if (tasks.some((t) => t.unitId === id && t.status === "running")) reject("Closing is clean", `unit ${id} has a running task`);
    if (u.revisePending) reject("Closing is clean", `unit ${id} has a revision not yet delivered; its leader answers it first`);
    if (rootUnit && id === rootUnit.id) reject("Closing is clean", "command is never closed");
  }
  for (const id of cancelled) {
    const t = taskById.get(id);
    if (!t) reject("Closing is clean", `cancelTasks names "${id}", which is no task`);
    else if (!["pending", "ready"].includes(t.status)) reject("Closing is clean", `task ${id} is ${t.status}; only a pending or ready task is cancelled by a plan`);
  }

  // span of control
  const children = new Map();
  for (const u of units) if (u.status === "active" && u.parentId) children.set(u.parentId, (children.get(u.parentId) ?? 0) + 1);
  for (const u of created) children.set(u.parent, (children.get(u.parent) ?? 0) + 1);
  for (const c of closes) { const u = unitById.get(c.unitId ?? c); if (u?.parentId) children.set(u.parentId, (children.get(u.parentId) ?? 1) - 1); }
  for (const [parent, n] of children) {
    if (n > 7) reject("Span of control", `unit ${parent} would have ${n} direct children; seven is the most`);
    else if (n > 5) warn("Span of control", `unit ${parent} would have ${n} direct children; five is the target`);
  }

  // budget
  const remaining = state.incident?.budget;
  if (remaining) {
    const spent = state.incident?.spent ?? {};
    const need = proposals.reduce((a, t) => ({ tokens: a.tokens + (t.budget?.tokens ?? 0), seconds: a.seconds + (t.budget?.seconds ?? 0) }), { tokens: 0, seconds: 0 });
    if (remaining.tokens !== undefined && (spent.tokens ?? 0) + need.tokens > remaining.tokens) reject("Budget respected", `the plan's tasks need ${need.tokens} tokens on top of ${spent.tokens ?? 0} spent, over the incident's ${remaining.tokens}`);
    if (remaining.seconds !== undefined && (spent.seconds ?? 0) + need.seconds > remaining.seconds) reject("Budget respected", `the plan's tasks need ${need.seconds} seconds on top of ${spent.seconds ?? 0} spent, over the incident's ${remaining.seconds}`);
  }

  // status is earned
  if (p.incidentStatus === "satisfied") {
    if (proposals.length > 0) reject("Status is earned", `satisfied while creating ${proposals.length} task(s)`);
    const stillOpen = tasks.filter((t) => openTaskStatuses.has(t.status) && !cancelled.has(t.id));
    if (stillOpen.length > 0) reject("Status is earned", `satisfied with ${stillOpen.length} task(s) still open: ${stillOpen.map((t) => t.id).join(", ")}`);
    // Whether the claim that answers the objective is observed is the IC's judgment and is not
// checkable here: nothing in the record says which claim carries the conclusion. This checks
// only that the run observed something at all, and the rule asks the IC to name an inference
// it satisfies on.
    if (!claims.some((c) => c.basis === "observed")) reject("Status is earned", "satisfied with no observed claim anywhere in the record; the run established nothing by observation");
  }
  if (!["continue", "satisfied", "failed"].includes(p.incidentStatus)) reject("Fields complete", `incidentStatus is "${p.incidentStatus}"; continue, satisfied or failed`);
}

// ---- A command turn -----------------------------------------------------------------------
function checkCommand(t) {
  for (const f of ["periodObjectives", "priorities"]) if (!Array.isArray(t[f]) || t[f].length === 0) reject("Fields complete", `the turn has no ${f}`);
  if (!t.situation) reject("Fields complete", "the turn carries no situation");
  // reports answered: one verdict per unit whose last report awaits one
  const awaiting = (state.reports ?? []).filter((r) => !r.verdict);
  const lastByUnit = new Map();
  for (const r of awaiting) lastByUnit.set(r.unitId, r);
  const verdicts = t.reportVerdicts ?? [];
  const seen = new Set();
  for (const v of verdicts) {
    const last = lastByUnit.get(v.unitId);
    if (!last) reject("Reports answered", `a verdict names unit ${v.unitId}, which has no report awaiting one`);
    else if (last.id !== v.reportId) reject("Reports answered", `report ${v.reportId} is not unit ${v.unitId}'s last report this window; its verdict answers report ${last.id}`);
    if (seen.has(v.unitId)) reject("Reports answered", `unit ${v.unitId} has two verdicts`);
    seen.add(v.unitId);
    if (v.verdict === "accepted" && v.instructions) reject("Reports answered", `an accepted verdict on ${v.unitId} carries instructions`);
    if (["revise", "reassign"].includes(v.verdict) && !v.instructions) reject("Reports answered", `a ${v.verdict} verdict on ${v.unitId} carries no instructions`);
    if (v.verdict === "revise" && (t.closeUnits ?? []).some((c) => (c.unitId ?? c) === v.unitId)) reject("Reports answered", `unit ${v.unitId} is revised and in closeUnits; a revised unit stays`);
  }
  for (const [unitId, last] of lastByUnit) if (!seen.has(unitId)) reject("Reports answered", `report ${last.id} of unit ${unitId} has no verdict`);
  // situation grounded
  const s = t.situation ?? {};
  for (const e of s.evidence ?? []) if (!claimIds.has(e.claimId)) reject("Situation grounded", `the situation names claim ${e.claimId}, which does not exist`);
  const priorIds = new Set((state.situation?.open ?? []).map((o) => o.id).filter(Boolean));
  const carried = new Set();
  for (const o of s.open ?? []) {
    if (o.id !== undefined) {
      if (!priorIds.has(o.id)) reject("Situation grounded", `open item "${o.id}" is carried with an id the last picture did not list; a new item carries no id`);
      if (carried.has(o.id)) reject("Situation grounded", `open item ${o.id} is listed twice`);
      carried.add(o.id);
    }
  }
  if (s.assessment && !["on_track", "priors_updated", "tactics_change"].includes(s.assessment.kind)) reject("Situation grounded", `assessment.kind is "${s.assessment.kind}"`);
  // assignments under command: deterministic only, own unit
  const assigns = t.assignTasks ?? [];
  const refsInPlan = new Set(assigns.map((a) => a.ref).filter(Boolean));
  checkTasks(assigns, { refsInPlan, unitsInPlan: new Set(), cancelled: new Set(), rule: "Fields complete" });
  assigns.forEach((a, i) => {
    if (rootUnit && a.unit !== rootUnit.id) reject("Own unit", `${label(a, i)} is under ${a.unit}; the IC assigns under command (${rootUnit.id}) only`);
    if (!isEquipment(a.resource)) reject("Deterministic only", `${label(a, i)} runs ${a.resource}, a session resource; session work goes under a unit with a leader`);
  });
  // drops
  for (const d of t.dropReassignments ?? []) {
    const r = (state.reassignments ?? []).find((x) => x.id === d.id);
    if (!r || r.status !== "open") reject("Drops match", `no open reassignment ${d.id} to drop`);
  }
  // proposals ruled, on the first turn only
  const proposals = state.briefing?.questions ?? [];
  const firstTurn = !(state.period?.number > 0);
  if (firstTurn && proposals.length > 0) {
    const ruled = new Map();
    for (const r of t.briefingQuestions ?? []) {
      if (r.proposal < 1 || r.proposal > proposals.length) reject("Proposals ruled", `ruling on proposal ${r.proposal}; the briefing proposed ${proposals.length}`);
      ruled.set(r.proposal, (ruled.get(r.proposal) ?? 0) + 1);
      if (r.verdict === "answer" && !r.answer) reject("Proposals ruled", `proposal ${r.proposal} is answered with no answer`);
    }
    proposals.forEach((_, i) => { const n = ruled.get(i + 1) ?? 0; if (n === 0) reject("Proposals ruled", `proposal ${i + 1} has no ruling`); if (n > 1) reject("Proposals ruled", `proposal ${i + 1} is ruled on ${n} times`); });
  } else if (!firstTurn && (t.briefingQuestions ?? []).length > 0) reject("Proposals ruled", "rulings on the briefing's proposals belong to the first turn only");
  // closes
  for (const c of t.closeUnits ?? []) {
    const id = c.unitId ?? c; const u = unitById.get(id);
    if (!u) reject("Closing is clean", `closeUnits names "${id}", which is no unit`);
    else if (tasks.some((x) => x.unitId === id && x.status === "running")) reject("Closing is clean", `unit ${id} has a running task`);
  }
  if (t.incidentStatus === "satisfied") {
    const stillOpen = tasks.filter((x) => openTaskStatuses.has(x.status));
    if (stillOpen.length + assigns.length > 0) reject("Status is earned", `satisfied with ${stillOpen.length + assigns.length} task(s) open or assigned`);
    // Closing on an inference is allowed and sometimes right. Closing on one without saying so
    // is what the record cannot tell from a fact, so the warning asks for the sentence, not for
    // more work: this is a decision the IC makes, never an errand it runs itself.
    const byId = new Map(claims.map((c) => [c.id, c]));
    const standingOn = (t.situation?.evidence ?? []).filter((e) => e.stance === "for")
      .map((e) => byId.get(e.claimId)).filter((c) => c && c.basis === "inferred");
    const named = standingOn.filter((c) => String(t.rationale ?? "").includes(c.id));
    if (standingOn.length && !named.length)
      warn("Status is earned", `satisfied while the picture stands on ${standingOn.length} inferred claim(s) (${standingOn.map((c) => c.id).join(", ")}) and the rationale names none. Decide, do not go looking: either say in the rationale why the inference is good enough to close on and what would have settled it, or send the unit back with a revise naming the one observation you want. Re-reading the evidence yourself is not the answer to this warning`);
  }
}

// ---- A unit leader's turn ------------------------------------------------------------------
function checkLeader(t, unitId) {
  const unit = unitById.get(unitId);
  if (!unit) { reject("Own unit", `"${unitId}" is no unit`); return; }
  if (!["report", "continue"].includes(t.kind)) reject("Fields complete", `kind is "${t.kind}"; report or continue`);
  if (t.kind === "report") {
    const r = t.report;
    if (!r) { reject("Fields complete", "a report turn carries its report"); }
    else {
      if (!["met", "not_met", "progress"].includes(r.outcome)) reject("Fields complete", `report.outcome is "${r.outcome}"; met, not_met or progress`);
      if (r.outcome === "not_met" && (!r.why || !r.suggestion)) reject("Fields complete", "a not_met report says why and carries a suggestion");
      if (typeof r.pictureChanged !== "boolean") reject("Fields complete", "report.pictureChanged is missing");
      if (!r.situation || !r.situation.picture) reject("Fields complete", "the report carries no situation (the unit's own picture of its slice)");
      for (const e of r.situation?.evidence ?? []) if (!claimIds.has(e.claimId)) reject("Situation grounded", `the unit's situation names claim ${e.claimId}, which does not exist`);
      for (const c of r.changes ?? []) if (c.claimId && !claimIds.has(c.claimId)) reject("Fields complete", `the report changes claim ${c.claimId}, which does not exist`);
      if (r.outcome === "met") {
        const observed = claims.some((c) => c.basis === "observed" && tasks.find((x) => x.id === c.provenance?.taskId)?.unitId === unitId);
        if (!observed) reject("Provenance on everything", "met with no observed claim from this unit's tasks in the record");
      }
    }
  } else if (t.report) reject("Fields complete", "a continue turn carries no report");
  const assigns = t.assignTasks ?? [];
  const refsInPlan = new Set(assigns.map((a) => a.ref).filter(Boolean));
  checkTasks(assigns, { refsInPlan, unitsInPlan: new Set(), cancelled: new Set() });
  assigns.forEach((a, i) => { if (a.unit !== unitId) reject("Own unit", `${label(a, i)} is under ${a.unit}; a leader assigns under its own unit (${unitId})`); });
  for (const c of t.consult ?? []) {
    const own = taskById.get(c)?.unitId === unitId;
    if (!own && !refsInPlan.has(c)) reject("Fields complete", `consult names "${c}", which is neither a task of unit ${unitId} nor the ref of a task assigned on this turn`);
  }
}

// ---- A task session's result ----------------------------------------------------------------
function checkResult(r, taskId) {
  const task = taskById.get(taskId);
  if (!task) { reject("Fields complete", `"${taskId}" is no task`); return; }
  if (!["answered", "insufficient"].includes(r.outcome)) reject("Fields complete", `outcome is "${r.outcome}"; answered or insufficient`);
  if (r.outcome === "answered" && (r.findings === null || r.findings === undefined)) reject("Fields complete", "an answered result carries findings");
  if (r.pictureChanged !== undefined && typeof r.pictureChanged !== "boolean") reject("Fields complete", "pictureChanged is true or false: whether what this task found is not what its brief expected, which calls the leader");
  if (r.outcome === "insufficient") {
    if (!Array.isArray(r.needed) || r.needed.length === 0) reject("Fields complete", "an insufficient result names what it lacked (needed)");
    for (const n of r.needed ?? []) if (!["retrievable_fact", "permission", "missing_means", "human_knowledge"].includes(n.kind)) reject("Fields complete", `needed.kind "${n.kind}" is not one of the four kinds of lack`);
  }
  const attached = new Set((task.evidenceFrom?.tasks ?? []).filter((id) => taskById.get(id)?.status === "completed" && isEquipment(taskById.get(id)?.resource)));
  (r.claims ?? []).forEach((c, i) => {
    const name = `claim #${i + 1}`;
    for (const f of ["subject", "predicate"]) if (!c[f]) reject("Provenance on everything", `${name} has no ${f}`);
    if (!["observed", "inferred"].includes(c.basis)) reject("Provenance on everything", `${name} has basis "${c.basis}"; observed or inferred`);
    if (typeof c.confidence !== "number" || c.confidence < 0 || c.confidence > 1) reject("Provenance on everything", `${name} has no confidence between 0 and 1`);
    for (const id of c.cites ?? []) {
      if (!taskById.has(id)) reject("Provenance on everything", `${name} cites "${id}", which is no task`);
      else if (!attached.has(id)) warn("Provenance on everything", `${name} cites ${id}, which is not attached to this task's brief as completed deterministic evidence; the claim will be recorded as inferred`);
    }
    if (c.basis === "observed" && (c.cites ?? []).length === 0 && isEquipment(task.resource)) reject("Provenance on everything", `${name} is observed from a deterministic task; only a session asserts claims`);
  });
}

// ---- The size-up's briefing -----------------------------------------------------------------
const FIX = /\b(fix|implement|remediat|patch|repair|correct the|change the code|add (a|the))\b/i;
const INTENDED = /\b(intended|should (it|the|deletion|focus|we|this)|expected behavior|desired behavior)\b/i;
const DIAGNOSIS = /^\s*(determine|identify|explain|find|why|what|where|how|which|is|does|investigate|diagnose)\b/i;
function checkBriefing(b) {
  for (const f of ["kind", "dominantProblem"]) if (typeof b[f] !== "string" || b[f] === "") reject("Fields complete", `the briefing has no ${f}`);
  if (!Array.isArray(b.initialObjectives) || b.initialObjectives.length === 0) reject("Fields complete", "the briefing sketches no initial objective");
  for (const f of ["obviouslyNeeded", "initialOrganization", "questionsForHuman", "hazards"]) if (!Array.isArray(b[f])) reject("Fields complete", `the briefing has no ${f} list`);
  (b.obviouslyNeeded ?? []).forEach((n, i) => { if (n.checked && !n.finding) reject("Fields complete", `need #${i + 1} ("${String(n.what ?? "").slice(0, 50)}") is marked checked with no finding`); });
  for (const seat of ["planner", "leader"]) { const m = b.seatModels?.[seat]; if (m && (!m.model || !m.why)) reject("Fields complete", `seatModels.${seat} needs model and why`); if (m?.model && !KNOWN_MODELS.some((k) => String(m.model).includes(k))) reject("Model known", `seatModels.${seat} names ${m.model}; the provider serves ${KNOWN_MODELS.join(", ")}`); }
  if (b.incomingCommander?.model && !KNOWN_MODELS.some((k) => String(b.incomingCommander.model).includes(k))) reject("Model known", `incomingCommander names ${b.incomingCommander.model}; the provider serves ${KNOWN_MODELS.join(", ")}`);
  if (!b.incomingCommander?.model || !b.incomingCommander?.provider || !b.incomingCommander?.why) reject("Fields complete", "incomingCommander names no provider, model and why");
  const objective = state.incident?.objective ?? "";
  const diagnosis = /diagnos/i.test(b.kind ?? "") || DIAGNOSIS.test(objective);
  if (diagnosis) {
    (b.initialObjectives ?? []).forEach((o, i) => { if (FIX.test(o)) reject("Scoped to the kind", `initial objective #${i + 1} proposes a fix on a diagnosis: "${o.slice(0, 80)}"`); });
    (b.initialOrganization ?? []).forEach((u, i) => { if (FIX.test(u)) reject("Scoped to the kind", `unit #${i + 1} is a fix unit on a diagnosis: "${u.slice(0, 80)}"`); });
    (b.questionsForHuman ?? []).forEach((q, i) => { if (INTENDED.test(q)) reject("Scoped to the kind", `question #${i + 1} asks about intended behavior on a diagnosis: "${q.slice(0, 80)}"`); });
  }
}

// ---- The IC's review of a draft ---------------------------------------------------------------
function checkReview(r, draftPathForReview) {
  if (!["approve", "correct", "amend"].includes(r.verdict)) reject("Fields complete", `verdict is "${r.verdict}"; approve, correct or amend`);
  if (typeof r.rationale !== "string" || r.rationale === "") reject("Fields complete", "the review has no rationale");
  if (r.verdict === "correct") {
    if (!Array.isArray(r.patches) || r.patches.length === 0) reject("Patch applies", "a correct verdict carries at least one patch");
    if (!draftPathForReview) { warn("Patch applies", "no draft given, so the patches' task refs are not checked; pass the draft as the fourth argument"); }
    const plan = draftPathForReview ? JSON.parse(readFileSync(draftPathForReview, "utf8")) : null;
    const drafted = plan?.createTasks ?? [];
    const addr = (a) => { if (typeof a !== "string") return null; const m = /^#(\d+)$/.exec(a); if (m) return drafted[Number(m[1]) - 1] ?? null; return drafted.find((t) => t.ref === a) ?? null; };
    (r.patches ?? []).forEach((p, i) => {
      const name = `patch #${i + 1}`;
      if (!["set", "add", "cancel"].includes(p.kind)) { reject("Patch applies", `${name} has kind "${p.kind}"; set, add or cancel`); return; }
      if (p.kind === "set") {
        if (!p.field) reject("Patch applies", `${name} names no field to set`);
        if (p.value === undefined) reject("Patch applies", `${name} sets ${p.field ?? "a field"} to no value`);
        if (plan && !addr(p.task)) reject("Patch applies", `${name} names task "${p.task}", which is no ref and no #N position in the draft`);
      }
      if (p.kind === "add" && (!p.proposal || !p.proposal.resource)) reject("Patch applies", `${name} adds no task proposal`);
      if (p.kind === "cancel" && plan && !addr(p.task) && !taskById.has(p.task)) reject("Patch applies", `${name} cancels "${p.task}", which is neither a draft task nor an open task`);
    });
  } else if (Array.isArray(r.patches) && r.patches.length > 0) reject("Patch applies", `a ${r.verdict} verdict carries patches`);
  if (r.verdict === "amend") { if (!r.plan) reject("Fields complete", "an amend verdict carries the whole plan"); else checkPlan(r.plan); }
  else if (r.plan) reject("Fields complete", `a ${r.verdict} verdict carries a plan`);
}

// ---- An outgoing IC's handoff -----------------------------------------------------------------
function checkHandoff(h) {
  if (!h.period || !Array.isArray(h.period.objectives)) reject("Fields complete", "the handoff carries no period with its objectives");
  if (!Array.isArray(h.units)) reject("Fields complete", "the handoff lists no units");
  for (const u of h.units ?? []) { if (!unitById.has(u.id ?? u.unitId ?? "")) reject("Fields complete", `the handoff lists unit "${u.id ?? u.unitId}", which is no unit`); }
  const active = units.filter((u) => u.status === "active" && u.parentId);
  const listed = new Set((h.units ?? []).map((u) => u.id ?? u.unitId));
  for (const u of active) if (!listed.has(u.id)) reject("Fields complete", `active unit ${u.id} is missing from the handoff`);
  if (!h.hypothesis || (typeof h.hypothesis === "object" && !h.hypothesis.statement && !h.hypothesis.picture)) reject("Fields complete", "the handoff carries no hypothesis (the picture as you hold it)");
  if (!Array.isArray(h.setAside)) reject("Fields complete", "the handoff has no setAside list (empty is fine)");
  for (const x of h.setAside ?? []) if (!x.what || !x.why) reject("Fields complete", "a setAside entry names what was set aside and why");
  if (typeof h.nextMove !== "string" || h.nextMove === "") reject("Fields complete", "the handoff says no nextMove");
  for (const id of h.hypothesis?.claims ?? h.hypothesis?.evidence?.map((e) => e.claimId) ?? []) if (!claimIds.has(id)) reject("Situation grounded", `the handoff's hypothesis names claim ${id}, which does not exist`);
}

// ---- A brief going down: the right keys present, the IC's picture absent ----------------------
const PICTURE_KEYS = ["situation", "picture", "assessment", "hypothesis", "open", "openItems"];
function noPicture(obj, where) {
  for (const k of PICTURE_KEYS) if (obj && Object.hasOwn(obj, k)) reject("Observations flow up", `${where} carries "${k}"; the IC's picture never goes below the IC`);
}
function checkBrief(b, kind, id) {
  const need = (keys, where) => { for (const k of keys) if (!(k in b)) reject("Brief complete", `${where} lacks "${k}"`); };
  if (kind === "orientation") {
    const unit = unitById.get(id ?? "");
    if (!unit) { reject("Brief complete", `"${id}" is no unit; pass the unit id`); return; }
    need(["objective", "unit", "hierarchy"], "a leader's orientation");
    for (const k of ["id", "objective", "equipment", "bashAllowlist"]) if (!(k in (b.unit ?? {}))) reject("Brief complete", `the orientation's unit lacks "${k}"`);
    if (b.unit?.id !== unit.id) reject("Brief complete", `the orientation is for unit ${b.unit?.id}, not ${unit.id}`);
    if (b.reassignment) { const r = (state.reassignments ?? []).find((x) => x.id === b.reassignment.id); if (!r) reject("Brief complete", `the orientation names reassignment ${b.reassignment.id}, which does not exist`); for (const c of b.reassignment.claims ?? []) if (!claimIds.has(c.id ?? c)) reject("Brief complete", `the reassignment carries claim ${c.id ?? c}, which does not exist`); }
    noPicture(b, "a leader's orientation");
  } else if (kind === "turn") {
    const unit = unitById.get(id ?? "");
    if (!unit) { reject("Brief complete", `"${id}" is no unit; pass the unit id`); return; }
    need(["unheard", "ready", "running", "ask"], "a leader's turn prompt");
    for (const e of b.unheard ?? []) {
      const t = taskById.get(e.taskId);
      if (!t) reject("Brief complete", `unheard names task ${e.taskId}, which does not exist`);
      else if (t.unitId !== unit.id) reject("Brief complete", `unheard names task ${e.taskId}, which is unit ${t.unitId}'s, not ${unit.id}'s`);
      else if (!["completed", "failed", "insufficient", "cancelled"].includes(e.status)) reject("Brief complete", `unheard ending ${e.taskId} has status "${e.status}"`);
      if (e.status === "completed" && !isEquipment(t?.resource ?? "") && !("summary" in e || "claims" in e)) reject("Brief complete", `unheard ending ${e.taskId} is a completed session task with no summary or claims`);
      if (e.status === "failed" && !("reason" in e)) reject("Brief complete", `unheard ending ${e.taskId} failed with no reason`);
      if (e.status === "insufficient" && !("needed" in e)) reject("Brief complete", `unheard ending ${e.taskId} is insufficient with no needed`);
    }
    if (b.revise) { for (const k of ["instructions", "why", "report", "periodObjectives"]) if (!(k in b.revise)) reject("Brief complete", `the revise brief lacks "${k}"`); if (/\b(the answer is|the cause is|I think|my hypothesis)\b/i.test(b.revise.instructions ?? "")) warn("Observations flow up", "the revise instructions read like an answer rather than what is missing"); }
    const decision = (b.unheard ?? []).some((e) => e.status !== "completed") || b.revise || (b.unheard ?? []).some((e) => e.consult || e.pictureChanged) || ((b.ready ?? []).length === 0 && (b.running ?? []).length === 0);
    if (!decision) warn("A model call is a decision", "every unheard ending is a plain completion, no revise is due, no consult was flagged and tasks are ready or running: this turn calls the leader for process");
    noPicture(b, "a leader's turn prompt");
  } else if (kind === "task") {
    const task = taskById.get(id ?? "");
    if (!task) { reject("Brief complete", `"${id}" is no task; pass the task id`); return; }
    need(["objective", "unit", "evidence", "task"], "a task brief");
    for (const k of ["objective", "inputs", "expectedOutput", "completionCriteria", "evidenceRequired"]) if (!(k in (b.task ?? {}))) reject("Brief complete", `the task brief's task lacks "${k}"`);
    const wantClaims = new Set(task.evidenceFrom?.claims ?? []); const wantTasks = new Set(task.evidenceFrom?.tasks ?? []);
    const gotClaims = new Set((b.evidence?.claims ?? []).map((c) => c.id ?? c)); const gotTasks = new Set((b.evidence?.results ?? []).map((r) => r.taskId ?? r.id ?? r));
    for (const c of wantClaims) if (!gotClaims.has(c)) reject("Brief complete", `the task's evidenceFrom names claim ${c}, which the brief does not attach`);
    for (const t of wantTasks) if (!gotTasks.has(t)) reject("Brief complete", `the task's evidenceFrom names task ${t}, whose result the brief does not attach`);
    for (const r of b.evidence?.results ?? []) if (r.result === undefined && r.output === undefined) reject("Brief complete", `attached result ${r.taskId ?? r.id} carries no result body; evidence is attached whole`);
    noPicture(b, "a task brief");
  } else if (kind === "planner") {
    need(["incident", "checklist", "ask"], "the planner's ask");
    for (const k of ["incident", "period", "situation", "units", "tasks", "claims", "evidence", "reassignments", "resources"]) if (!(k in (b.incident ?? {}))) reject("Brief complete", `the planner's copy of incident.json lacks "${k}"`);
  } else if (kind === "sizeup") {
    need(["objective", "constraints", "priorities", "workingDirectory", "ask"], "the size-up ask");
    noPicture(b, "the size-up ask");
  } else reject("Brief complete", `kind "${kind}" is not orientation, turn, task, planner or sizeup`);
}

if (mode === "brief") checkBrief(draft, extra ?? "", idArg);
else if (mode === "plan") checkPlan(draft);
else if (mode === "command") checkCommand(draft);
else if (mode === "leader") checkLeader(draft, extra ?? "");
else if (mode === "result") checkResult(draft, extra ?? "");
else if (mode === "briefing") checkBriefing(draft);
else if (mode === "review") checkReview(draft, extra);
else checkHandoff(draft);
for (const w of warns) console.log(w);
for (const r of rejects) console.log(r);
if (rejects.length === 0 && warns.length === 0) console.log("OK: every rule holds");
process.exit(rejects.length > 0 ? 1 : 0);
