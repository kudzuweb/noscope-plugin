#!/usr/bin/env node
// The line that delivers a brief. A brief travels as a file and the message or prompt carrying
// it is one line naming that file, the plugin root, the run folder and which seat this is.
// `hooks/lib.mjs` reads those four back with four regexes and `noscope-guard-brief.mjs` refuses
// the send when they are not all there, so the line is built here rather than typed at a call
// site: a field spelled differently is a refusal the seat then has to diagnose, and a field the
// guard happens not to require is one nobody notices is missing.
//
//   node incident_seatline.mjs <run folder> sizeup  <brief path>
//   node incident_seatline.mjs <run folder> planner <brief path>
//   node incident_seatline.mjs <run folder> task    <brief path> <task-id>
//   node incident_seatline.mjs <run folder> turn    <brief path> <unit-id>
//
// A task and the two agent seats are told to return an object, because a hook reads it out of
// their last message. A leader turn is not: a leader records its own turn with the scripts.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { aliasOf } from "./incident_lib.mjs";

const PLUGIN_ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const [folder, kind, briefPath, id] = process.argv.slice(2);
const statePath = folder ? join(folder, "incident.json") : null;
if (!statePath || !existsSync(statePath) || !kind || !briefPath) {
  console.error("usage: incident_seatline.mjs <run folder> <sizeup|planner|task|turn> <brief path> [id]; see the header");
  process.exit(2);
}
if (!existsSync(briefPath)) { console.error(`no brief at ${briefPath}; write incident_brief.mjs's output there first`); process.exit(2); }

const RETURN = "Return your object as the last thing you say, as one JSON code block.";
const parts = [`Brief file: ${resolve(briefPath)}.`, `Plugin root: ${PLUGIN_ROOT}.`, `Run folder: ${resolve(folder)}.`];

if (kind === "task") {
  if (!id) { console.error("a task seat line needs the task id"); process.exit(2); }
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  const t = state.tasks.find((x) => x.id === id);
  if (!t) { console.error(`no task ${id} in ${statePath}`); process.exit(2); }
  parts.push(`Your task: ${id}.`);
  // The id and the alias both: the id is what the record holds and the alias is what the Agent
  // tool takes, and the leader that spawns this seat must not have to convert between them.
  if (t.model) parts.push(`Model: ${t.model} (Agent tool alias: ${aliasOf(t.model) ?? "unknown — ask the IC"}).`);
  parts.push(RETURN);
} else if (kind === "turn") {
  if (!id) { console.error("a turn seat line needs the unit id"); process.exit(2); }
  parts.push(`Your unit: ${id}.`);
} else if (kind === "sizeup" || kind === "planner") {
  parts.push(RETURN);
} else { console.error("kind is sizeup, planner, task or turn"); process.exit(2); }

console.log(parts.join(" "));
