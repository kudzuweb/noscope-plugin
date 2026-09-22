// Shared by the plugin's hooks: reading the hook's stdin, finding the run folder, pulling the
// seat's object out of its last message, running the scripts, and the applied-events file the
// after-tool hook reports from.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { currentRunFolder, loadState, loadRun, NOSCOPE_HOME } from "../scripts/incident_lib.mjs";

export const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const SCRIPTS = join(PLUGIN_ROOT, "scripts");

/** Which seat this session is: "ic" unless the launcher set NOSCOPE_ROLE (a leader session carries "leader"). */
export const ROLE = process.env.NOSCOPE_ROLE || "ic";
export function readInput() {
  try { return JSON.parse(readFileSync(0, "utf8")); } catch { return {}; }
}
/** The open incident this session is in, or null: {folder, statePath, state, run}. */
export function openIncident(cwd) {
  const folder = currentRunFolder(cwd ?? process.cwd());
  if (!folder) return null;
  const statePath = join(folder, "incident.json");
  const state = loadState(statePath);
  return { folder, statePath, state, run: loadRun(statePath), hooksDir: hooksDir(folder) };
}
export const ENDED = new Set(["satisfied", "failed", "stopped"]);
export function hooksDir(folder) { const d = join(folder, "hooks"); mkdirSync(d, { recursive: true }); return d; }

/** The last fenced JSON block in a message, else the last balanced top-level object; null when none parses. */
export function lastJsonObject(text) {
  if (!text) return null;
  const fenced = [...String(text).matchAll(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/g)];
  for (let i = fenced.length - 1; i >= 0; i--) { try { const v = JSON.parse(fenced[i][1]); if (v && typeof v === "object") return v; } catch {} }
  const s = String(text); let end = s.lastIndexOf("}");
  while (end > 0) {
    let depth = 0;
    for (let i = end; i >= 0; i--) {
      if (s[i] === "}") depth++; else if (s[i] === "{") { depth--; if (depth === 0) { try { const v = JSON.parse(s.slice(i, end + 1)); if (v && typeof v === "object") return v; } catch {} break; } }
    }
    end = s.lastIndexOf("}", end - 1);
  }
  return null;
}
/** The brief a prompt carries (a `Brief file: <path>` line read from disk, else the first JSON object inline), and the seat line's fields. */
export function briefAndSeatLine(text) {
  const s = String(text ?? "");
  let obj = null;
  const briefFile = s.match(/Brief file:\s*(\S+)/)?.[1]?.replace(/[.,;]+$/, "") ?? null;
  if (briefFile) { try { obj = JSON.parse(readFileSync(briefFile, "utf8")); } catch { obj = null; } }
  if (!obj) {
  const fenced = s.match(/```(?:json)?\s*\n([\s\S]*?)\n\s*```/);
  if (fenced) { try { obj = JSON.parse(fenced[1]); } catch {} }
  if (!obj) { const start = s.indexOf("{"); if (start >= 0) { let depth = 0; for (let i = start; i < s.length; i++) { if (s[i] === "{") depth++; else if (s[i] === "}") { depth--; if (depth === 0) { try { obj = JSON.parse(s.slice(start, i + 1)); } catch {} break; } } } } }
  }
  const seat = {
    briefFile,
    pluginRoot: s.match(/Plugin root:\s*(\S+)/)?.[1]?.replace(/[.,;]+$/, "") ?? null,   // the sentence's full stop is not part of the path
    runFolder: s.match(/Run folder:\s*(\S+)/)?.[1]?.replace(/\.$/, "") ?? null,
    unitId: s.match(/Your unit:\s*(\S+)/)?.[1]?.replace(/[.,]$/, "") ?? null,
    taskId: s.match(/Your task:\s*(\S+)/)?.[1]?.replace(/[.,]$/, "") ?? null,
  };
  return { brief: obj, seat };
}
/** Runs a script; returns {code, out} with stdout and stderr joined. */
export function run(script, args) {
  try { return { code: 0, out: execFileSync("node", [join(SCRIPTS, script), ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) }; }
  catch (e) { return { code: e.status ?? 1, out: `${e.stdout ?? ""}${e.stderr ?? ""}` }; }
}
export const rejects = (out) => out.split("\n").filter((l) => l.startsWith("REJECT"));
export const warns = (out) => out.split("\n").filter((l) => l.startsWith("WARN"));

export function writeJson(path, obj) { writeFileSync(path, JSON.stringify(obj, null, 2) + "\n"); }
export function stamp() { return new Date().toISOString().replace(/[:.]/g, "-"); }
/** Records what a hook applied, for the after-tool hook to report to the IC once. */
export function noteApplied(folder, entry) {
  appendFileSync(join(hooksDir(folder), "applied.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}
export function unreported(folder, who = "ic") {
  const p = join(hooksDir(folder), "applied.jsonl"); if (!existsSync(p)) return [];
  const lines = readFileSync(p, "utf8").split("\n").filter(Boolean);
  const cursorPath = join(hooksDir(folder), `reported-${who}.txt`);
  const cursor = existsSync(cursorPath) ? Number(readFileSync(cursorPath, "utf8")) : 0;
  writeFileSync(cursorPath, String(lines.length));
  return lines.slice(cursor).map((l) => JSON.parse(l));
}
/** The newest file in the run folder matching a prefix, or null. */
export function newest(folder, prefix) {
  const files = readdirSync(folder).filter((n) => n.startsWith(prefix) && n.endsWith(".json")).map((n) => ({ n, t: statSync(join(folder, n)).mtimeMs })).sort((a, b) => b.t - a.t);
  return files.length ? join(folder, files[0].n) : null;
}
/** The subagent's own transcript, from the hook input, or null. */
export function subagentTranscript(input) {
  const tp = input.transcript_path; if (!tp) return null;
  if (basename(tp).startsWith("agent-") && existsSync(tp)) return tp;
  const candidates = [];
  if (input.agent_id) {
    const dir = dirname(tp), sid = basename(tp, ".jsonl");
    candidates.push(join(dir, sid, "subagents", `agent-${input.agent_id}.jsonl`), join(dir, "subagents", `agent-${input.agent_id}.jsonl`));
    if (input.session_id) candidates.push(join(dir, input.session_id, "subagents", `agent-${input.agent_id}.jsonl`));
  }
  return candidates.find((c) => existsSync(c)) ?? null;
}
export function out(obj) { process.stdout.write(JSON.stringify(obj)); }

// A seat that ended because the request failed, not because it answered badly. The text is a
// tool response for a spawn that never ran, or the seat's own last message when it died
// mid-turn (seen 2026-09-21: a planner ended on "API Error: 529 Overloaded" after 214s).
// A failed seat has nothing to correct, so it is respawned rather than pushed back.
export const FAILED_CALL = /^(Error|error:|API Error|Request failed|overloaded)/i;
export const failedCall = (text) => FAILED_CALL.test(String(text ?? "").trim());

// A seat that declined the work, as opposed to one whose request failed. The two need opposite
// responses: a failed call is the same request again, a refusal is a judgment the model made,
// so repeating it on the same model repeats the judgment. Only ever consulted when the seat
// returned no object at all — an `insufficient` result is a seat saying it could not finish,
// which is a valid answer and never a refusal, however its prose reads.
// The object is what separates a refusal from a finding: a seat saying "I can't find the
// function" or "I cannot reproduce the behaviour" is doing its job, and only "I can't help",
// "I won't assist", "I am not able to comply" and their kin are declining the work. Negation
// is required on the able forms, so "I am able to help" is not a refusal.
export const REFUSAL = new RegExp(
  String.raw`\bI(?:'m|\s+am)?\s+(?:can(?:not|'t)|won'?t|will\s+not|not\s+able\s+to|unable\s+to)\s+`
  + String.raw`(?:help|assist|comply|continue|provide|do\s+(?:that|this))\b`
  + String.raw`|\b(?:cannot|can't)\s+assist\s+with\b|\bI\s+decline\s+to\b`, "i");
export const refusedCall = (text) => REFUSAL.test(String(text ?? ""));

// Where a launched seat says it is up. Keyed by the session name the launcher passed as
// NOSCOPE_SEAT, not by the run folder: a `start` tab has no incident yet, and the launcher needs
// one path it can watch for all three roles. launch-session.sh clears the file before it
// opens the tab and polls for it afterwards.
export function upPath(seat) { return join(NOSCOPE_HOME, "up", `${String(seat).replace(/[^A-Za-z0-9._-]/g, "_")}.json`); }
export function markUp(seat, sessionId) {
  if (!seat) return;
  try {
    const p = upPath(seat);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ seat, sessionId: sessionId ?? null, at: new Date().toISOString() }) + "\n");
  } catch {}
}
/** Agent seats a session has spawned and not yet heard stop: a counter file per session in the run's hooks folder. */
export function inflightPath(folder, sessionId) { return join(hooksDir(folder), `inflight-${sessionId ?? "session"}.json`); }
export function inflight(folder, sessionId, delta) {
  const p = inflightPath(folder, sessionId);
  let n = 0; try { n = JSON.parse(readFileSync(p, "utf8")).n ?? 0; } catch {}
  if (delta !== undefined) { n = Math.max(0, n + delta); writeFileSync(p, JSON.stringify({ n, at: new Date().toISOString() })); }
  return n;
}
/** Logs one model call from a transcript's summed usage (usageOfTranscript) under a seat and an id. */
export function logCall(statePath, seat, u, id = "") {
  return run("incident_apply.mjs", ["call", statePath, seat, u.model ?? "unknown", String(u.inputTokens), String(u.outputTokens), String(Math.round(u.seconds)), "", id, String(u.cache.read), String(u.cache.write5m), String(u.cache.write1h), JSON.stringify(u.toolCalls ?? {})]).out.trim();
}
/** Logs a validator's REJECT lines against the record, so the review can count rejections. */
export function logRejected(statePath, kind, text, id = "") {
  const tmp = join(hooksDir(dirname(statePath)), `rejected-${kind}-${stamp()}.txt`);
  writeFileSync(tmp, text);
  return run("incident_apply.mjs", ["rejected", statePath, kind, tmp, id]).out.trim();
}
