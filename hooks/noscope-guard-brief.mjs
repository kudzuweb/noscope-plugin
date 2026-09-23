#!/usr/bin/env node
// PreToolUse on Agent and SendMessage: a brief going down to a seat passes the validator's brief
// mode first, so nothing reaches a seat that is not built from the record, and nothing below
// the IC carries its situation. Refuses with the REJECT lines; lets anything else through.
import { join } from "node:path";
import { existsSync } from "node:fs";
import { readInput, openIncident, ENDED, briefAndSeatLine, run, rejects, writeJson, stamp, inflight } from "./lib.mjs";

const input = readInput();
const tool = input.tool_name; const ti = input.tool_input ?? {};
const inc = openIncident(input.cwd);
if (!inc || ENDED.has(inc.state.incident.status)) process.exit(0);

let kind = null, text = null;
if (tool === "Agent") {
  const type = String(ti.subagent_type ?? "").replace(/^noscope:/, "");
  if (!/^(sizeup|planner|task-)/.test(type)) process.exit(0);
  text = ti.prompt; kind = type.startsWith("task-") ? "task" : type;
} else if (tool === "SendMessage") {
  // No test on the recipient's name. Matching one meant a pattern here and a naming convention
  // in incident_name.mjs that had to agree, and when the names became IC-…/UL-…/TSK-… this
  // guard silently stopped guarding every message to a leader. Whether a message carries a
  // brief is the thing being asked, so ask that: the brief check below exits on anything else,
  // and the gate already means only a session inside an incident reaches this hook at all.
  text = typeof ti.message === "string" ? ti.message : JSON.stringify(ti.message ?? "");
  const { brief, seat: s0 } = briefAndSeatLine(text);
  if (!brief) { if (s0.briefFile) { process.stderr.write(`Brief refused: the Brief file ${s0.briefFile} does not exist or is not JSON\n`); process.exit(2); } process.exit(0); }   // plain text to a leader: no brief to check
  kind = "unheard" in brief ? "turn" : "task" in brief ? "task" : null;
  if (!kind) process.exit(0);
} else process.exit(0);

const { brief, seat } = briefAndSeatLine(text);
const refuse = (why) => { process.stderr.write(`Brief refused (${kind}): ${why}\n`); process.exit(2); };
if (!brief) refuse(seat.briefFile ? `the Brief file ${seat.briefFile} does not exist or is not JSON` : "the prompt carries no brief; write incident_brief.mjs's output to a file in the run folder and name it with `Brief file: <path>.` in the seat line");
if (!seat.pluginRoot || !seat.runFolder) refuse("the seat line is missing; end the prompt with `Plugin root: <root>. Run folder: <folder>.` and the seat's unit or task id");
const id = kind === "orientation" || kind === "turn" ? seat.unitId : kind === "task" ? seat.taskId : null;
if ((kind === "orientation" || kind === "turn") && !id) refuse("the seat line needs `Your unit: <unit id>`");
if (kind === "task" && !id) refuse("the seat line needs `Your task: <task id>`");
// Validate the file the seat line names. Copying it first put a byte-identical second copy of
// every brief into hooks/ — 452K in one run — that nothing ever read. Only a brief that arrived
// inline, with no file behind it, needs one written.
let file = seat.briefFile && existsSync(seat.briefFile) ? seat.briefFile : null;
if (!file) { file = join(inc.hooksDir, `brief-${kind}-${stamp()}.json`); writeJson(file, brief); }
const v = run("incident_validator.mjs", ["brief", inc.statePath, file, kind, ...(id ? [id] : [])]);
if (v.code !== 0) refuse(rejects(v.out).join("; "));
// The Agent tool runs a seat in the background and the session's turn may end before the seat
// returns; the loop hook must not push the session while one of its seats is in flight.
if (tool === "Agent") inflight(inc.folder, input.session_id, +1);
process.exit(0);
