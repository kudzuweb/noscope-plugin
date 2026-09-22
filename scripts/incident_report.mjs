#!/usr/bin/env node
// The morning report: what a reader with no memory of the run needs, written from the record.
// Outcome, then what needs the human (open questions, a blocked or failed status, resource
// requests), then each period's verdicts and disputes, then the After Action Review whole.
//
//   node incident_report.mjs incident.json    prints Markdown
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadState, readLog, loadRun } from "./incident_lib.mjs";

const [statePath] = process.argv.slice(2);
if (!statePath) { console.error("usage: incident_report.mjs incident.json"); process.exit(2); }
const state = loadState(statePath), log = readLog(statePath), run = loadRun(statePath);
const s = state.incident;
const out = [];
const say = (l = "") => out.push(l);

say(`# Morning report: incident ${s.id}`); say();
say(`Objective: ${s.objective}`); say();
const outcome = { satisfied: "The objective is met on observed claims.", failed: "The objective could not be met.", blocked: "The incident is waiting on a question only you can answer.", stopped: `The run was stopped by a human${run?.paused ? ` (${run.paused})` : ""}; /noscope-resume reopens it on purpose.`, open: run?.paused ? `The run is paused (${run.paused}).` : "The incident is open and unfinished." }[s.status] ?? `Status: ${s.status}.`;
say(`**Outcome:** ${outcome} ${state.period.number} operational period(s); ${state.claims.length} claim(s) (${state.claims.filter((c) => c.basis === "observed").length} observed); status \`${s.status}\`.`);
if (run) say(`Run: ${run.attended ? "attended" : "unattended"}, ${run.mode}${run.cutoffAt ? ` (cutoff ${run.cutoffAt})` : ""}${run.heartbeat?.cronId ? `, heartbeat ${run.heartbeat.cronId}` : ""}.`);
say();

say("## Needs you"); say();
const needs = [];
for (const q of state.questions ?? []) if (!q.answer) needs.push(`Question ${q.id}: ${q.text ?? q.question ?? JSON.stringify(q)} (answer with \`incident_apply.mjs answer\`, then \`/noscope-resume\`)`);
if (s.status === "failed") { const last = [...log].reverse().find((e) => e.type === "command.turned"); needs.push(`The incident failed: ${last?.rationale ?? "see the last command turn"}`); }
for (const r of state.reports ?? []) for (const rr of r.resourceRequests ?? []) needs.push(`Unit ${r.unitId} asked for ${rr.kind}: ${rr.what} (${rr.why})`);
const stops = log.filter((e) => e.type === "run.stopped" || e.type === "run.updated" && e.key === "paused");
for (const e of stops) needs.push(`Run stopped ${e.at}: ${e.value ?? e.reason ?? ""}`);
if (!needs.length) say("Nothing: no open question, no resource request, no stop that needs a decision."); else for (const n of needs) say(`- ${n}`);
say();

say("## Situation as the IC last wrote it"); say();
say(state.situation?.picture || "(none yet)"); say();
if (state.situation?.open?.length) { say("Open items:"); for (const o of state.situation.open) say(`- ${o.id ?? ""} ${o.what} (settled by: ${o.settledBy}${o.deferred ? `; deferred: ${o.deferred}` : ""})`); say(); }

say("## Verdicts and revisions"); say();
const verdicts = log.filter((e) => e.type === "report.reviewed");
if (!verdicts.length) say("No report has been judged yet."); else for (const v of verdicts) say(`- ${v.at}: ${v.unitId} report ${v.reportId}: **${v.verdict}**. ${v.why ?? ""}${v.instructions ? ` Instructions: ${v.instructions}` : ""}`);
say();

say("## Sessions"); say();
const transfers = log.filter((e) => e.type === "command.transferred");
if (!transfers.length) say("One IC session; no transfer of command."); else for (const t of transfers) say(`- ${t.at}: command from ${t.from}${t.to ? ` to ${t.to}` : ""}${t.handoff?.nextMove ? ` (next move: ${t.handoff.nextMove})` : ""}`);
say();

say("## After Action Review"); say(); say("```");
say(execFileSync("node", [join(dirname(fileURLToPath(import.meta.url)), "incident_review.mjs"), statePath], { encoding: "utf8" }).trim());
say("```");
console.log(out.join("\n"));
