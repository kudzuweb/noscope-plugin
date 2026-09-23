#!/usr/bin/env node
// SubagentStop for the plugin's seats (agent_type noscope:sizeup, noscope:planner, noscope:task-*; a unit
// leader is a session of its own and records its turns itself). Reads the seat's object from its last message, checks it with the validator
// mode for that seat, and applies it to the record; a REJECT blocks the seat's stop with the
// reasons so it returns a corrected object. Also logs the seat's model call from its transcript.
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { readInput, openIncident, ENDED, lastJsonObject, run, rejects, warns, writeJson, stamp, noteApplied, subagentTranscript, out, logCall, logRejected, inflight, failedCall, refusedCall } from "./lib.mjs";
import { usageOfTranscript, fallbackOf } from "../scripts/incident_lib.mjs";

const input = readInput();
const inc = openIncident(input.cwd);
if (!inc || ENDED.has(inc.state.incident.status)) process.exit(0);
const { folder, statePath, state, hooksDir } = inc;
// Every invocation leaves a line, so a result that never reached the record can be traced.
const trace = (what) => { try { appendFileSync(join(hooksDir, "seat-stop.log"), `${new Date().toISOString()} agent=${input.agent_id ?? "?"} type=${input.agent_type ?? "?"} ${what}\n`); } catch {} };
// Which seat this was. agent_type carries the name the spawner gave, not the plugin-scoped
// type (seen 2026-09-21: "noscope-sizeup-001" for a spawn of noscope:sizeup), so the seat is read from
// the name when it says, and otherwise from the seat's own brief in its transcript.
const tp = subagentTranscript(input);
const kind = (() => {
  // The name the spawner gave carries the seat word somewhere ("noscope-planner-002-1b", "task-001-t17").
  const t = String(input.agent_type ?? "");
  const m = /(sizeup|planner|task-(?:investigate|reproduce|interpret))/.exec(t);
  if (m) return m[1];
  if (!tp) return null;
  let head = ""; try { head = readFileSync(tp, "utf8").slice(0, 20000); } catch { return null; }
  if (!/Plugin root:/.test(head)) return null;                 // not one of ours
  if (/Your task:/.test(head)) { const id = /Your task:\s*(\S+?)[.,\s]/.exec(head)?.[1]; const cap = state.tasks.find((x) => x.id === id)?.resource; return `task-${cap ?? "investigate"}`; }
  // The brief travels as a file; its keys say which seat this is.
  const bf = /Brief file:\s*(\S+)/.exec(head)?.[1]?.replace(/[.,;]+$/, "");
  if (bf) { try { const b = JSON.parse(readFileSync(bf, "utf8")); if ("task" in b) { const cap = state.tasks.find((x) => x.id === b.task?.id)?.resource ?? b.task?.resource; return `task-${cap ?? "investigate"}`; } if ("checklist" in b || "sinceLastPlan" in b) return "planner"; if ("availableModels" in b) return "sizeup"; } catch {} }
  if (/IncidentBriefing/.test(head)) return "sizeup";
  if (/ActionPlan/.test(head)) return "planner";
  return null;
})();
if (!kind) { trace("not a seat; ignored"); process.exit(0); }
trace(`kind=${kind}`);
// One seat landed (whatever it returned); the session that spawned it may be pushed again.
// A pushed-back seat returns again, so the count goes back up when it is blocked below.
inflight(folder, input.session_id, -1);
// A seat whose task has already ended (a finished seat resumed by a message stops again) is
// left alone: no demand for an object, no second application, no logged rejection.
if (kind.startsWith("task-")) {
  const named = /(\d{3}-t\d+)/.exec(String(input.agent_type ?? ""))?.[1] ?? null;
  const known = named ?? (() => { try { return tp ? /Your task:\s*(\S+?)[.,\s]/.exec(readFileSync(tp, "utf8"))?.[1] ?? null : null; } catch { return null; } })();
  const t = known ? state.tasks.find((x) => x.id === known) : null;
  if (t && !["pending", "ready", "running"].includes(t.status)) { trace(`task ${t.id} already ${t.status}; ignored`); process.exit(0); }
}

// Loop guard: block the same seat at most three times.
const blocksPath = join(hooksDir, "blocks.json");
const blocks = existsSync(blocksPath) ? JSON.parse(readFileSync(blocksPath, "utf8")) : {};
const obj = lastJsonObject(input.last_assistant_message);
const block = (reason) => {
  blocks[input.agent_id] = (blocks[input.agent_id] ?? 0) + 1; writeFileSync(blocksPath, JSON.stringify(blocks));
  const validatorKind = kind === "sizeup" ? "briefing" : kind === "planner" ? "plan" : "result";
  logRejected(statePath, validatorKind, reason, obj?.taskId ?? "");
  if (blocks[input.agent_id] > 3) {
    // Three rejected returns: the seat will not produce a valid object. A task ends failed, so
    // its dependents settle and its leader is called; a planner or size-up failure is logged for the IC.
    let result = `gave up after three rejected returns: ${reason.split("\n")[0]}`;
    if (kind.startsWith("task-")) { const taskId = obj?.taskId ?? taskIdFromSeatLine(); if (taskId) { const f = join(hooksDir, `failed-${taskId}.json`); writeJson(f, { error: result }); result += "; " + run("incident_apply.mjs", ["ending", statePath, f, taskId]).out.trim(); } }
    noteApplied(folder, { seat: kind, agentId: input.agent_id, result, call: callNote }); process.exit(0);
  }
  trace(`blocked (${blocks[input.agent_id]}): ${reason.split("\n")[0].slice(0, 120)}`);
  inflight(folder, input.session_id, +1);
  out({ decision: "block", reason: `${reason}\n\nFix the object and return it again as the last thing you say, as one JSON code block.` }); process.exit(0);
};
// A task whose result never parsed still has its id in the transcript's first prompt (the seat line).
const taskIdFromSeatLine = () => { try { const tp0 = subagentTranscript(input); if (!tp0) return null; const m = /Your task:\s*(\S+?)[.,\s]/.exec(readFileSync(tp0, "utf8")); return m?.[1] ?? null; } catch { return null; } };
const seatName = kind === "sizeup" ? "initial_ic" : kind === "planner" ? "planner" : "task";

// The call, from the seat's transcript, whether or not the object is good.
let callNote = "no transcript found; the call is unlogged";
if (tp) {
  // A seat stops once per return; a pushed-back seat returns again, so count only the
  // messages since the last stop logged for this agent (the same cursor the turn hook keeps).
  const cursorPath = join(hooksDir, `turns-agent-${input.agent_id ?? "unknown"}.json`);
  const cursor = existsSync(cursorPath) ? JSON.parse(readFileSync(cursorPath, "utf8")) : { lastUuid: null };
  const u = usageOfTranscript(tp, cursor.lastUuid);
  const id = obj?.taskId ?? obj?.unitId ?? "";
  if (u.turns) { callNote = logCall(statePath, seatName, u, id); writeJson(cursorPath, { lastUuid: u.lastUuid, at: new Date().toISOString() }); }
  else callNote = "no new messages since the last logged call";
}

// A seat killed by a failed request never answered at all, so there is nothing to correct and
// no one left to read a push-back. Blocking it would also count it back into the session's
// in-flight seats and leave the spawner unpushed until the staleness limit released it. The
// spawner sees the failure in its own completion notification and respawns (the spawning rules in a seat's orientation).
if (!obj && failedCall(input.last_assistant_message)) {
  trace("failed; not pushed back");
  process.exit(0);
}
// A seat that declined the work. Pushing it back would ask the same model the same question,
// so the first refusal goes to the fallback model and the second ends the work: two models
// declining is a judgment about the request, not about a seat. Counted per task rather than
// per agent, because the retry is a new agent with a new id.
if (!obj && refusedCall(input.last_assistant_message)) {
  const why = String(input.last_assistant_message ?? "").trim().slice(0, 300);
  const taskId = kind.startsWith("task-")
    ? (/(\d{3}-t\d+)/.exec(String(input.agent_type ?? ""))?.[1] ?? taskIdFromSeatLine())
    : null;
  const refusalsPath = join(hooksDir, `refusals-${taskId ?? kind}.json`);
  const prior = existsSync(refusalsPath) ? JSON.parse(readFileSync(refusalsPath, "utf8")) : [];
  const refusals = [...prior, { model: input.model ?? null, why, at: new Date().toISOString() }];
  writeJson(refusalsPath, refusals);
  trace(`refused (${refusals.length}): ${why.split("\n")[0].slice(0, 100)}`);
  // Where it would fall back to: the previous generation in the same tier. Every seat this hook
  // sees is an Agent-tool subagent — the size-up, the planner, a task — because the Incident
  // Commander and unit leaders are sessions and never raise SubagentStop. The Agent tool's model
  // takes an alias, sonnet, opus, haiku or fable, which cannot name a generation, so the
  // predecessor is named for the record and the spawner is told what it can actually do.
  const ranOn = taskId ? state.tasks.find((x) => x.id === taskId)?.model
    : kind === "planner" ? (inc.run?.models?.planner ?? null)
    : kind === "sizeup" ? "claude-haiku-4-5"
    : null;
  const next = fallbackOf(ranOn);
  let result;
  if (refusals.length === 1 && next) {
    result = taskId
      ? `refused on ${ranOn}; run it again as a session on ${next}, its tier's previous model, which the Agent tool cannot name: bash $PLUGIN/scripts/launch-session.sh refusal_fallback ${folder} ${next} noscope-${state.incident.id}-${taskId}-fb ${taskId}. The session does the task's own brief and records its own ending; a second refusal ends the work`
      : `refused on ${ranOn}; its tier falls back to ${next}, which the Agent tool cannot be asked for. Spawn it once more unchanged; a second refusal ends the work`;
  } else if (refusals.length === 1) {
    result = `refused on ${ranOn ?? "an unrecorded model"}, which has no earlier generation to fall back to. Spawn it once more unchanged; a second refusal ends the work`;
  } else if (taskId) {
    const f = join(hooksDir, `failed-${taskId}.json`);
    writeJson(f, { refusals });
    result = `refused twice; ${run("incident_apply.mjs", ["ending", statePath, f, taskId]).out.trim()}`;
  } else {
    result = `refused twice on ${kind}; it will not run, and the next command turn's rationale says so`;
  }
  noteApplied(folder, { seat: kind, agentId: input.agent_id, result, call: callNote });
  process.exit(0);
}
if (!obj) {
  block("Your last message carried no JSON object. The plugin reads your result from the last JSON code block in your final message.");
}

const file = join(hooksDir, `${kind}-${stamp()}.json`);
writeJson(file, obj);
let applied;

if (kind === "sizeup") {
  const v = run("incident_validator.mjs", ["briefing", statePath, file]);
  if (v.code !== 0) block(rejects(v.out).join("\n"));
  writeJson(join(folder, "briefing.json"), obj);
  applied = run("incident_apply.mjs", ["briefing", statePath, join(folder, "briefing.json")]).out;
} else if (kind === "planner") {
  const draft = join(folder, `draft-${state.period.number}.json`);
  writeJson(draft, obj);
  const v = run("incident_validator.mjs", ["plan", statePath, draft]);
  writeFileSync(join(folder, `warnings-${state.period.number}.txt`), warns(v.out).join("\n") + "\n");
  if (v.code !== 0) block(rejects(v.out).join("\n"));
  applied = `draft saved as ${draft}; ${warns(v.out).length} warning(s) in warnings-${state.period.number}.txt; not applied: review it`;
} else {
  // The task id is on the seat line the seat was spawned with; a result without it is not a shape error.
  const taskId = obj.taskId ?? taskIdFromSeatLine(); if (!taskId) block('Your result needs "taskId": "<your task id>" at the top level.');
  obj.taskId = taskId;
  const v = run("incident_validator.mjs", ["result", statePath, file, taskId]);
  if (v.code !== 0) block(rejects(v.out).join("\n"));
  applied = run("incident_apply.mjs", ["ending", statePath, file, taskId]).out;
}
noteApplied(folder, { seat: kind, agentId: input.agent_id, result: applied.trim(), call: callNote });
trace(`applied: ${applied.trim().split("\n")[0]}`);
process.exit(0);
