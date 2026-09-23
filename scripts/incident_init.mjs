#!/usr/bin/env node
// Opens an incident: creates its run folder in the incidents repository
// (<incidentsDir>/<project>/<id>/, where incidentsDir is the configured central folder and
// project the working directory's basename), with incident.json (the state's shape from
// state.example.json, holding only the objective, constraints, priorities and working
// directory), run.json (how the run is driven) and log.jsonl; registers the folder against the
// working directory in ~/.claude/noscope/current.json so the hooks and the other scripts find it;
// and initializes the incidents repository as a git repository when it is not one.
//
//   node incident_init.mjs <working-directory> --objective "<text>"
//        [--constraint "<text>"]... [--priority "<text>"]...
//        [--budget-tokens N] [--budget-seconds N]
//        [--mode until_done|cutoff] [--cutoff-at <ISO>] [--attended yes|no]
//        [--incidents-dir <path>]       overrides the configured incidentsDir
//        [--ic-model <id|smallest>] [--leader-model <id|smallest>] [--planner-model <id|smallest>]   override the configured seat models
//
// Prints the run folder's path. With --mode cutoff and no --cutoff-at, the cutoff is the
// configured work start (~/.claude/noscope/config.json, default 09:00) minus the usage window (5 h).
import { mkdirSync, writeFileSync, readdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { appendLog, loadConfig, cutoffBefore, saveRun, loadCurrent, saveCurrent, watchRun, loadSavedConfigs, resolveModel, joinSession } from "./incident_lib.mjs";

const args = process.argv.slice(2);
const wd = args[0] && !args[0].startsWith("--") ? resolve(args[0]) : null;
if (!wd || !existsSync(wd)) { console.error("usage: incident_init.mjs <working-directory> --objective \"<text>\" [options]; see the header"); process.exit(2); }
const opt = { constraints: [], priorities: [] };
for (let i = 1; i < args.length; i++) {
  const k = args[i], v = args[i + 1];
  if (k === "--objective") { opt.objective = v; i++; }
  else if (k === "--constraint") { opt.constraints.push(v); i++; }
  else if (k === "--priority") { opt.priorities.push(v); i++; }
  else if (k === "--budget-tokens") { opt.budgetTokens = Number(v); i++; }
  else if (k === "--budget-seconds") { opt.budgetSeconds = Number(v); i++; }
  else if (k === "--mode") { opt.mode = v; i++; }
  else if (k === "--cutoff-at") { opt.cutoffAt = v; i++; }
  else if (k === "--attended") { opt.attended = v; i++; }
  else if (k === "--incidents-dir") { opt.incidentsDir = resolve(v); i++; }
  else if (k === "--ic-model") { opt.icModel = v; i++; }
  else if (k === "--leader-model") { opt.leaderModel = v; i++; }
  else if (k === "--planner-model") { opt.plannerModel = v; i++; }
  else { console.error(`unknown option ${k}`); process.exit(2); }
}
if (!opt.objective) { console.error("--objective is required"); process.exit(2); }
const config = { ...loadConfig(), ...(opt.icModel ? { icModel: opt.icModel } : {}), ...(opt.leaderModel ? { leaderModel: opt.leaderModel } : {}), ...(opt.plannerModel ? { plannerModel: opt.plannerModel } : {}) };
if (opt.mode && !["until_done", "cutoff"].includes(opt.mode)) { console.error("--mode is until_done or cutoff"); process.exit(2); }
if (opt.attended && !["yes", "no"].includes(opt.attended)) { console.error("--attended is yes or no"); process.exit(2); }

const incidentsDir = opt.incidentsDir ?? config.incidentsDir;
const runsDir = join(incidentsDir, basename(wd));
mkdirSync(runsDir, { recursive: true });
if (!existsSync(join(incidentsDir, ".git"))) {
  execFileSync("git", ["init", "-q"], { cwd: incidentsDir });
  writeFileSync(join(incidentsDir, "README.md"), "# noscope plugin incidents\n\nRecords written by the noscope Claude Code plugin, not by the noscope TypeScript runtime.\n\nOne folder per project (the working directory's basename), one folder per incident under it, written by the noscope Claude Code plugin: `incident.json` (the state), `log.jsonl` (every event), `run.json` (how the run was driven), the briefs, drafts, turns and results, and at the end `after-action-review.txt` and `morning-report.md`. Committed by the Incident Commander at every command turn.\n");
}
const taken = readdirSync(runsDir).filter((n) => /^\d{3}$/.test(n)).map(Number);
const id = String((taken.length ? Math.max(...taken) : 0) + 1).padStart(3, "0");
const folder = join(runsDir, id);
mkdirSync(folder);

const example = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "state.example.json"), "utf8"));
const state = {
  incident: {
    id, objective: opt.objective, constraints: opt.constraints, priorities: opt.priorities, status: "open", workingDirectory: wd,
    budget: { ...(opt.budgetTokens ? { tokens: opt.budgetTokens } : {}), ...(opt.budgetSeconds ? { seconds: opt.budgetSeconds } : {}) },
    spent: { tokens: 0, seconds: 0 },
  },
  period: { number: 0, objectives: [], priorities: [] },
  briefing: { questions: [] },
  situation: { picture: "", evidence: [], open: [], assessment: { kind: "on_track", why: "nothing observed yet" }, changed: "" },
  units: [{ id: `${id}-command`, parentId: null, type: "ic", objective: "the incident", leader: { provider: "claude-code", model: resolveModel("ic", config) ?? "smallest" }, resourcesAssigned: [], bashAllowlist: [], status: "active" }],
  tasks: [], claims: [], evidence: [], reports: [], reassignments: [], questions: [], resourceGaps: [], configs: loadSavedConfigs(),
  resources: example.resources,
};
const statePath = join(folder, "incident.json");
writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");

const mode = opt.mode ?? "until_done";
const run = {
  mode, attended: opt.attended !== "no",
  cutoffAt: mode === "cutoff" ? (opt.cutoffAt ?? cutoffBefore(config.workStarts, config.usageWindowHours)) : null,
  heartbeat: { everyMinutes: 15, cronId: null },
  models: { ic: config.icModel, leader: config.leaderModel, planner: config.plannerModel },
  openedAt: new Date().toISOString(), sessions: [],
};
saveRun(statePath, run);
appendLog(statePath, [{ type: "incident.opened", actor: "ic", objective: opt.objective, constraints: opt.constraints, priorities: opt.priorities, workingDirectory: wd, run }]);
const current = loadCurrent(); current[wd] = folder; saveCurrent(current);
// The failsafe daemon watches the runs that told it they exist.
watchRun(folder, opt.objective);
// The session that opened the incident is its first seat, so its hooks run from here on. Where
// the session id is not in the environment nothing is marked and the gate would let this
// session past every hook, so say so rather than letting the run go quiet.
const joined = joinSession(folder);
if (!joined) console.error(`WARN no session id in the environment, so this session is not marked a seat of ${folder} and its hooks will not run; join it with: node incident_session.mjs join ${folder} <session-id>`);
console.log(folder);
