#!/usr/bin/env node
// A seat that has stopped working and is waiting for nothing. Every signal it reads is already
// written by the runtime, so it decides nothing and asks no model: a seat is stalled when its
// last turn is older than the threshold and it has no subordinate still working. A seat waiting
// on a subordinate is not stalled however long it waits, which is why the subordinate check is
// the whole point — without it every seat with work in flight looks dead.
//
//   node incident_watch.mjs <run folder>                  the stalled seats, one block each
//   node incident_watch.mjs <run folder> --minutes 30     a threshold other than run.json's
//   node incident_watch.mjs <run folder> --json           the same as one object
//   node incident_watch.mjs <run folder> --notify         also queue each one for its superior
//
// Exit 0 when nothing is stalled, 3 when something is, 2 on a bad invocation. The superior of a
// leader is the IC; the superior of the IC is the human, and its notice is written for whoever
// reads the run next rather than sent anywhere.
import { existsSync, readFileSync, readdirSync, appendFileSync } from "node:fs";
import { join, basename } from "node:path";
import { loadState, loadRun, OPEN_TASK } from "./incident_lib.mjs";

const args = process.argv.slice(2);
const folder = args[0];
const flag = (name, fallback) => { const i = args.indexOf(name); return i === -1 ? fallback : args[i + 1]; };
const has = (name) => args.includes(name);

if (!folder || !existsSync(join(folder, "incident.json"))) {
  console.error("usage: incident_watch.mjs <run folder> [--minutes N] [--json] [--notify]");
  process.exit(2);
}

const statePath = join(folder, "incident.json");
const state = loadState(statePath);
const run = loadRun(statePath) ?? {};
const hooksDir = join(folder, "hooks");
const now = Date.now();
const MINUTES = Number(flag("--minutes", run.watch?.idleMinutes ?? 20));
if (!Number.isFinite(MINUTES) || MINUTES <= 0) { console.error("--minutes must be a positive number"); process.exit(2); }

const ENDED = new Set(["satisfied", "failed", "stopped"]);
const minutesSince = (iso) => { const t = Date.parse(iso ?? ""); return Number.isFinite(t) ? (now - t) / 60000 : null; };

// ---- what the runtime already wrote about each session ----------------------------------------
// turns-<session id>.json is written by the turn logger every time a session's turn ends.
const turnFiles = existsSync(hooksDir)
  ? readdirSync(hooksDir).filter((f) => f.startsWith("turns-") && f.endsWith(".json"))
  : [];
const turns = new Map();
for (const f of turnFiles) {
  try {
    const t = JSON.parse(readFileSync(join(hooksDir, f), "utf8"));
    const sid = t.sessionId ?? basename(f).slice("turns-".length, -".json".length);
    turns.set(sid, { ...t, sessionId: sid });
  } catch {}
}
const byRoleUnit = (role, unit) => [...turns.values()].find((t) => t.role === role && (unit === undefined || t.unit === unit));
const inflightOf = (sid) => {
  try { return JSON.parse(readFileSync(join(hooksDir, `inflight-${sid ?? "session"}.json`), "utf8")).n ?? 0; } catch { return 0; }
};

// ---- why it stopped, read and never inferred ---------------------------------------------------
// Three places say something, in the order they are worth having: an error the launcher caught,
// an error in the transcript, and failing those the last thing the seat actually said. Each is
// quoted as found. Nothing here guesses a cause; a seat that stopped quietly says so.
function lastWord(sid, transcriptPath) {
  const up = join(hooksDir, `${sid}.err`);
  if (existsSync(up)) {
    const txt = readFileSync(up, "utf8").trim();
    if (txt) return { kind: "launcher error", text: txt.split("\n").slice(-3).join(" ").slice(0, 300) };
  }
  if (!transcriptPath || !existsSync(transcriptPath)) return { kind: "nothing recorded", text: "no transcript was recorded for this session" };
  let lines;
  try { lines = readFileSync(transcriptPath, "utf8").split("\n").filter(Boolean); } catch { return { kind: "nothing recorded", text: "its transcript could not be read" }; }
  let lastText = null, lastError = null;
  for (const l of lines.slice(-400)) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.isApiErrorMessage || e.type === "error") {
      const t = typeof e.message === "string" ? e.message : JSON.stringify(e.message ?? e).slice(0, 300);
      lastError = t;
      continue;
    }
    if (e.type !== "assistant") continue;
    const content = e.message?.content;
    const text = Array.isArray(content)
      ? content.filter((c) => c?.type === "text").map((c) => c.text).join(" ")
      : typeof content === "string" ? content : "";
    if (text.trim()) lastText = text.trim();
  }
  if (lastError) return { kind: "error in transcript", text: lastError.slice(0, 300) };
  if (lastText) return { kind: "its last words", text: lastText.replace(/\s+/g, " ").slice(0, 300) };
  return { kind: "nothing recorded", text: "its transcript holds no message from it" };
}

// ---- the seats, and what each is waiting on -----------------------------------------------------
const openTasksOf = (unitId) => (state.tasks ?? []).filter((t) => t.unitId === unitId && OPEN_TASK.has(t.status));
const stalled = [];

if (!ENDED.has(state.incident?.status) && !run.paused) {
  // Every active unit that is not the command unit is a leader's; the command unit is the IC's.
  for (const u of state.units ?? []) {
    if (u.status !== "active") continue;
    const isIC = u.parentId === null || u.parentId === undefined || u.type === "ic";
    const role = isIC ? "ic" : "leader";
    const rec = byRoleUnit(role, isIC ? null : u.id) ?? (isIC ? byRoleUnit("ic") : undefined);
    const sid = rec?.sessionId ?? u.sessionId ?? (isIC ? run.icSession : null) ?? null;

    // Subordinates still working: this unit's own open tasks, plus, for the IC, every active unit
    // under it, plus any agent seat this session spawned and has not heard stop.
    const mine = openTasksOf(u.id);
    const childUnits = isIC ? (state.units ?? []).filter((x) => x.status === "active" && x.id !== u.id) : [];
    const spawned = inflightOf(sid);
    const busy = mine.length + childUnits.length + spawned;
    if (busy > 0) continue;

    const idle = minutesSince(rec?.at);
    if (idle === null) continue;                 // never took a turn here; nothing to measure against
    if (idle < MINUTES) continue;

    stalled.push({
      seat: role, unit: u.id, sessionId: sid,
      idleMinutes: Math.round(idle),
      lastTurnAt: rec.at,
      superior: isIC ? "the human" : "the IC",
      waitingOn: "nothing: no open task, no active unit under it, no seat it spawned still running",
      why: lastWord(sid, rec?.transcriptPath),
    });
  }

  // A running task past the time its own brief allowed it. The bound is in the record, so this
  // needs no threshold of its own and is the one stall that can be called with certainty.
  for (const t of state.tasks ?? []) {
    if (t.status !== "running" || !t.startedAt) continue;
    const secs = t.budget?.seconds;
    const ran = (now - Date.parse(t.startedAt)) / 1000;
    if (!Number.isFinite(secs) || !Number.isFinite(ran) || ran <= secs) continue;
    stalled.push({
      seat: "task", unit: t.unitId, taskId: t.id, sessionId: t.sessionId ?? null,
      idleMinutes: Math.round(ran / 60),
      lastTurnAt: t.startedAt,
      superior: `the leader of ${t.unitId}`,
      waitingOn: `nothing: it is ${Math.round(ran - secs)}s past the ${secs}s its brief allowed`,
      why: { kind: "nothing recorded", text: "a task subagent has no session transcript of its own; its work is in its parent's" },
    });
  }
}

// ---- say it ---------------------------------------------------------------------------------------
if (has("--json")) {
  console.log(JSON.stringify({ folder, thresholdMinutes: MINUTES, at: new Date().toISOString(), stalled }, null, 2));
} else if (stalled.length === 0) {
  console.log(`nothing is stalled: every seat took a turn inside ${MINUTES} minutes or is waiting on work that is running`);
} else {
  for (const s of stalled) {
    const who = s.taskId ? `task ${s.taskId}` : `the ${s.seat} of ${s.unit}`;
    console.log(`${who} has done nothing for ${s.idleMinutes} minutes and is waiting on nothing`);
    console.log(`  last acted ${s.lastTurnAt}; ${s.waitingOn}`);
    console.log(`  ${s.why.kind}: ${s.why.text}`);
    console.log(`  tell ${s.superior}`);
  }
}

// Queued the way the seat hooks queue everything else, so the superior is told the next time it
// does anything at all rather than needing this to reach into its session.
if (has("--notify") && stalled.length > 0) {
  for (const s of stalled) {
    const who = s.taskId ? `task ${s.taskId}` : `the ${s.seat} of ${s.unit}`;
    appendFileSync(join(hooksDir, "applied.jsonl"), JSON.stringify({
      at: new Date().toISOString(), seat: "watch",
      result: `${who} has done nothing for ${s.idleMinutes} minutes and is waiting on nothing (${s.why.kind}: ${s.why.text}). Tell ${s.superior}, or take it over.`,
    }) + "\n");
  }
}

process.exit(stalled.length > 0 ? 3 : 0);
