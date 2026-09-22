#!/usr/bin/env node
// The incident open in a working directory, for hooks and shell scripts that need it:
// prints {folder, id, status, period, attended, paused} as JSON, or nothing with exit 1.
//
//   node incident_current.mjs [working-directory]     default: the current directory
import { join } from "node:path";
import { currentRunFolder, loadState, loadRun } from "./incident_lib.mjs";
const folder = currentRunFolder(process.argv[2] ?? process.cwd());
if (!folder) process.exit(1);
const state = loadState(join(folder, "incident.json")); const run = loadRun(join(folder, "incident.json"));
console.log(JSON.stringify({ folder, id: state.incident.id, status: state.incident.status, period: state.period?.number ?? 0, attended: run?.attended !== false, paused: run?.paused ?? null, cutoffAt: run?.cutoffAt ?? null }));
