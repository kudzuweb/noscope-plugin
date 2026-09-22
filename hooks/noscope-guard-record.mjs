#!/usr/bin/env node
// PreToolUse on Write, Edit, MultiEdit and NotebookEdit: the record is written by the scripts
// only, so a hand edit of incident.json, log.jsonl or run.json in a run folder is refused.
import { basename, dirname, resolve } from "node:path";
import { readInput, PLUGIN_ROOT, openIncident } from "./lib.mjs";
const input = readInput();
const p = String(input.tool_input?.file_path ?? input.tool_input?.notebook_path ?? "");
const inc = p ? openIncident(input.cwd) : null;
if (inc && resolve(dirname(p)) === resolve(inc.folder) && ["incident.json", "log.jsonl", "run.json"].includes(basename(p))) {
  process.stderr.write(`${basename(p)} is the incident's record and is written only by the scripts in ${PLUGIN_ROOT}/scripts: incident_apply.mjs for state and log, incident_apply.mjs run for run.json. Use the script for what you meant to change.\n`);
  process.exit(2);
}
process.exit(0);
