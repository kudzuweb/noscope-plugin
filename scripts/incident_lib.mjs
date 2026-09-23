// Shared helpers for the incident scripts: reading and writing incident.json and log.jsonl,
// ids, and the small facts every script needs. No dependencies.
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// Records written before 2026-09-22 use the vocabulary from before the resource rename: the inventory was
// "capabilities", a task's assignment was "capability", and an unmet need was a
// "capabilityRequest". A resource is the assignable thing now, so an old record is read
// forward here rather than rewritten — incidents 001 and 002 are the only evidence this
// runtime has ever worked, and they are receipts, not files to edit. Saving normalizes them,
// which is why this runs on load and nowhere else.
//
// The old names are built from fragments on purpose. A rename script that sweeps this
// repository would otherwise rewrite them to the new names and turn every test below into
// `if (x && !x)`, which is silently false and leaves the shim inert (seen 2026-09-22, in the
// very commit that introduced it). Fragments make this function survive the next sweep.
const OLD = { inv: "capabil" + "ities", gap: "capabil" + "ityRequests", one: "capabil" + "ity" };
function renameAssignedResources(o) {
  if (o && typeof o === "object" && o.equipment !== undefined && o.resourcesAssigned === undefined) {
    o.resourcesAssigned = o.equipment;
    delete o.equipment;
  }
}
function readForward(state) {
  if (state[OLD.inv] && !state.resources) { state.resources = state[OLD.inv]; delete state[OLD.inv]; }
  if (state[OLD.gap] && !state.resourceGaps) { state.resourceGaps = state[OLD.gap]; delete state[OLD.gap]; }
  for (const list of [state.tasks ?? [], state.evidence ?? []]) {
    for (const item of list) {
      if (item[OLD.one] !== undefined && item.resource === undefined) { item.resource = item[OLD.one]; delete item[OLD.one]; }
    }
  }
  // A unit's assigned resources were called `equipment`, which collided with the resource kind
  // of the same name. Records written before the rename still carry the old key.
  (state.units ?? []).forEach(renameAssignedResources);
  (state.configs ?? []).forEach(renameAssignedResources);
  // A resource's kind was a boolean before it was an axis: `deterministic: true` is equipment,
  // false is personnel.
  for (const r of Object.values(state.resources ?? {})) {
    if (r && typeof r === "object" && r.deterministic !== undefined && r.kind === undefined) {
      r.kind = r.deterministic ? "equipment" : "personnel";
      delete r.deterministic;
    }
  }
  return state;
}
export function loadState(path) {
  return readForward(JSON.parse(readFileSync(path, "utf8")));
}
export function saveState(path, state) {
  writeFileSync(path, JSON.stringify(state, null, 2) + "\n");
}
export function logPath(statePath) {
  return join(dirname(statePath), "log.jsonl");
}
export function readLog(statePath) {
  const p = logPath(statePath);
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
export function appendLog(statePath, events) {
  const p = logPath(statePath);
  const existing = readLog(statePath);
  let seq = existing.length ? existing[existing.length - 1].sequence + 1 : 0;
  const lines = events.map((e) => JSON.stringify({ sequence: seq++, at: new Date().toISOString(), ...e }));
  appendFileSync(p, lines.join("\n") + "\n");
  return lines.length;
}
export function nextId(state, list, letter) {
  const prefix = `${state.incident.id}-${letter}`;
  const max = (list ?? []).reduce((m, x) => { const n = Number(String(x.id ?? x).slice(prefix.length)); return Number.isFinite(n) && String(x.id ?? x).startsWith(prefix) ? Math.max(m, n) : m; }, 0);
  return `${prefix}${String(max + 1).padStart(2, "0")}`;
}
export const OPEN_TASK = new Set(["pending", "ready", "running"]);
// Equipment runs in process and always answers the same way; personnel is a session that
// judges. Deterministic is the consequence of being equipment, which is what callers ask.
export const isDeterministic = (state, resource) => state.resources?.[resource]?.kind === "equipment";
export const rootUnit = (state) => (state.units ?? []).find((u) => u.parentId === null || u.parentId === undefined);
export function dependenciesMet(state, task) {
  return (task.dependsOn ?? []).every((d) => (state.tasks ?? []).find((t) => t.id === d)?.status === "completed");
}
export function refreshReady(state) {
  for (const t of state.tasks ?? []) if (t.status === "pending" && dependenciesMet(state, t)) t.status = "ready";
}
/** Cancel every pending or ready task that depends, transitively, on `rootId`; returns the cancelled ids. */
export function cascadeCancel(state, rootId, reason) {
  const out = [];
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift();
    for (const t of state.tasks ?? []) {
      if (["pending", "ready"].includes(t.status) && (t.dependsOn ?? []).includes(id)) {
        t.status = "cancelled"; t.because = rootId; t.reason = `waited on ${id}, which ${reason}`;
        out.push(t.id); queue.push(t.id);
      }
    }
  }
  return out;
}
export function measureOf(resource, output) {
  if (resource === "grep") { const m = Array.isArray(output?.matches) ? output.matches : []; return `${m.length} match(es) in ${new Set(m.map((x) => x.path)).size} file(s)`; }
  if (resource === "read") return `${String(output?.content ?? "").split("\n").length} line(s)`;
  if (resource === "git_history") return `${(output?.commits ?? []).length} commit(s), ${(output?.changes ?? []).length} working-tree change(s)`;
  if (resource === "check_path") return output?.exists ? `exists, a ${output.kind ?? "path"}` : "does not exist";
  return `${JSON.stringify(output ?? null).split("\n").length} line(s) of JSON`;
}

// --- The plugin's user configuration and the run folder --------------------------------------
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
// Under ~/.claude, which is Claude Code's own home, so this can only be the plugin's state
// and never the noscope TypeScript runtime's. The records folder has no such context — it
// sits beside the runtime's own checkout — so that one is named noscope-plugin-incidents.
export const NOSCOPE_HOME = join(homedir(), ".claude", "noscope");
export const CONFIG_PATH = join(NOSCOPE_HOME, "config.json");
export const CURRENT_PATH = join(NOSCOPE_HOME, "current.json");
export const CONFIGS_PATH = join(NOSCOPE_HOME, "configs.json");
// `preAccept` is off unless the human turned it on at install: it writes the folder-trust and
// external-CLAUDE.md flags into ~/.claude.json for a working directory, which is the human's
// click to give, not the plugin's to assume. Off, a launched tab waits on the dialog.
export const CONFIG_DEFAULTS = { workStarts: "09:00", handoffThreshold: 75, usageWindowHours: 5, incidentsDir: join(homedir(), "Documents", "Projects", "noscope-plugin-incidents"), icModel: "claude-sonnet-5", leaderModel: "claude-sonnet-5", plannerModel: "claude-opus-5", preAccept: false };
export const SMALLEST = "smallest";
export const AVAILABLE_MODELS = ["claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"];
/**
 * What the Agent tool's `model` accepts for each id. The tool takes a family alias and cannot
 * name a generation, while the record holds full ids, so every spawn has to cross that gap. It
 * lived as a sentence in the leader's skill, which meant a seat reading prose and typing the
 * answer; a wrong alias is not refused anywhere and the spawn simply dies. `incident_brief.mjs`
 * puts the alias in the brief so the leader reads it rather than works it out.
 */
export const MODEL_ALIAS = {
  "claude-fable-5-1": "fable",
  "claude-opus-5": "opus",
  "claude-sonnet-5": "sonnet",
  "claude-haiku-4-5": "haiku",
};
export const aliasOf = (model) => MODEL_ALIAS[String(model ?? "")] ?? null;
/**
 * Where a refused call goes next: the previous generation in the same tier. A refusal from a
 * powerful model is its safety classifier declining the request, not the work being impossible,
 * and the generation before it in that tier is the one likely to answer. So the fallback never
 * changes tier — a refused Sonnet task goes to the Sonnet before it, never up to an Opus, which
 * would cost more and would not be the same phenomenon. Haiku has no predecessor and so no
 * fallback: a refusal there ends the work.
 *
 * Reachable two ways, and they differ. `claude --model` takes a full model id, so a session seat
 * relaunched through launch-session.sh lands on the exact predecessor (verified 2026-09-22 for
 * every id below). The Agent tool's `model` takes four aliases — sonnet, opus, haiku, fable —
 * with no version pinning, so a subagent cannot be respawned on a predecessor at all; the seat
 * above it is told so rather than told to do something it cannot.
 */
export const FALLBACK_OF = {
  "claude-fable-5-1": "claude-fable-5",
  "claude-opus-5": "claude-opus-4-8",
  "claude-sonnet-5": "claude-sonnet-4-6",
  "claude-haiku-4-5": null,
};
export const fallbackOf = (model) => FALLBACK_OF[String(model ?? "")] ?? null;
/**
 * The model a seat runs on: the configured id as given, or, for "smallest" (the model judged
 * right-sized for that role for this incident), the size-up's judgment for that seat, which
 * `incident_apply.mjs briefing` writes onto run.json (`models.<seat>`). Null while "smallest"
 * is still unjudged, which is only before the size-up. `config` is the merge of
 * ~/.claude/noscope/config.json and run.json's `models` (run values first): `runConfig()`.
 */
export function resolveModel(seat, config) {
  const v = config[`${seat}Model`] ?? CONFIG_DEFAULTS[`${seat}Model`];
  return v === SMALLEST ? null : v;
}
/** The configuration a run uses: run.json's models over the machine's config. */
export function runConfig(statePath) {
  const run = loadRun(statePath);
  return { ...loadConfig(), ...Object.fromEntries(Object.entries(run?.models ?? {}).map(([k, v]) => [`${k}Model`, v])) };
}
/** The answers /noscope-install recorded, over the defaults; missing file means defaults. */
export function loadConfig() {
  try { return { ...CONFIG_DEFAULTS, ...JSON.parse(readFileSync(CONFIG_PATH, "utf8")) }; } catch { return { ...CONFIG_DEFAULTS }; }
}
/** current.json maps a working directory to the run folder of the incident open in it. */
export function loadCurrent() {
  try { return JSON.parse(readFileSync(CURRENT_PATH, "utf8")); } catch { return {}; }
}
export function saveCurrent(map) {
  mkdirSync(NOSCOPE_HOME, { recursive: true });
  writeFileSync(CURRENT_PATH, JSON.stringify(map, null, 2) + "\n");
}
/** The run folder of the incident open in `cwd` (or a parent of it), or null. */
export function currentRunFolder(cwd = process.cwd()) {
  const map = loadCurrent();
  let dir = resolve(cwd);
  for (;;) {
    const folder = map[dir];
    if (folder && existsSync(join(folder, "incident.json"))) return folder;
    const up = dirname(dir); if (up === dir) return null; dir = up;
  }
}
/** The saved unit configs shared across incidents (`incident_apply.mjs config` writes them). */
export function loadSavedConfigs() {
  try { const list = JSON.parse(readFileSync(CONFIGS_PATH, "utf8")); list.forEach(renameAssignedResources); return list; } catch { return []; }
}
export function saveSavedConfigs(list) {
  mkdirSync(NOSCOPE_HOME, { recursive: true });
  writeFileSync(CONFIGS_PATH, JSON.stringify(list, null, 2) + "\n");
}
/** run.json beside incident.json: how this run is to be driven (mode, attended, cutoffAt, heartbeat). */
export function loadRun(statePath) {
  const p = join(dirname(statePath), "run.json");
  return existsSync(p) ? JSON.parse(readFileSync(p, "utf8")) : null;
}
export function saveRun(statePath, run) {
  writeFileSync(join(dirname(statePath), "run.json"), JSON.stringify(run, null, 2) + "\n");
}
/** The next local occurrence of HH:MM minus `hoursBefore`, as an ISO string. */
export function cutoffBefore(workStarts, hoursBefore, from = new Date()) {
  const [h, m] = String(workStarts).split(":").map(Number);
  const start = new Date(from); start.setHours(h, m ?? 0, 0, 0);
  if (start <= from) start.setDate(start.getDate() + 1);
  return new Date(start.getTime() - hoursBefore * 3600 * 1000).toISOString();
}

/** The field list of one returned object (`IncidentBriefing`, `ActionPlan`, `LeaderTurn`, a resource's result), from the protocol's Formats section, so a brief tells the seat the exact shape it returns. */
/**
 * The shape a seat fills: the object in the form it returns it in, every value the instruction
 * for that field. references/protocol-objects.json is generated from the protocol, so this and
 * the document cannot disagree. Falls back to the protocol's prose if the file is missing.
 */
export function shapeOf(objectName) {
  try {
    const doc = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "references", "protocol-objects.json"), "utf8"));
    return doc.shapes?.[objectName] ?? fieldListOf(objectName);
  } catch { return fieldListOf(objectName); }
}
export function fieldListOf(objectName) {
  const doc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "references", "noscope-protocol.md"), "utf8");
  const lines = doc.split("\n");
  const start = lines.findIndex((l) => l.startsWith("### ") && (l.includes("`" + objectName + "`") || l.includes("(`" + objectName + "`)")));
  if (start < 0) return null;
  let end = start + 1; while (end < lines.length && !lines[end].startsWith("### ") && !lines[end].startsWith("## ")) end++;
  return lines.slice(start, end).join("\n").trim();
}

/** The checklist's rules table from the protocol, as text, so a planner's brief carries the rules it is held to. */
export function checklistText() {
  const doc = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "references", "noscope-protocol.md"), "utf8");
  const start = doc.indexOf("| Rule | What it requires |");
  if (start < 0) return null;
  const rest = doc.slice(start); const end = rest.indexOf("\n\n");
  return rest.slice(0, end < 0 ? undefined : end).trim();
}

// --- List prices, USD per million tokens, for the After Action Review -----------------------
// One table prices every call; from the claude-api skill's model table (cached 2026-06-24).
export const LIST_PRICES = {
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};
/** List price in USD; cache reads at 0.1x input, 5-minute cache writes at 1.25x, 1-hour writes at 2x. */
export function priceOf(model, inputTokens, outputTokens, cache = {}) {
  const key = Object.keys(LIST_PRICES).find((k) => String(model ?? "").includes(k.replace(/-\d{8}$/, "")));
  const p = key ? LIST_PRICES[key] : null;
  if (!p) return null;
  const { read = 0, write5m = 0, write1h = 0 } = cache;
  return (inputTokens * p.input + outputTokens * p.output + read * p.input * 0.1 + write5m * p.input * 1.25 + write1h * p.input * 2) / 1e6;
}
/** Sums a Claude Code transcript's assistant usage (after a given message uuid, or all of it) into one call record for `incident_apply.mjs call`. */
export function usageOfTranscript(path, afterUuid = null) {
  const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
  const sum = { inputTokens: 0, outputTokens: 0, cache: { read: 0, write5m: 0, write1h: 0 }, model: null, first: null, last: null, turns: 0, lastUuid: null, toolCalls: {} };
  let counting = afterUuid === null;
  for (const l of lines) {
    let e; try { e = JSON.parse(l); } catch { continue; }
    if (e.type !== "assistant" || !e.message?.usage) continue;
    if (!counting) { if (e.uuid === afterUuid) counting = true; continue; }
    sum.lastUuid = e.uuid ?? sum.lastUuid;
    const u = e.message.usage; sum.turns++;
    sum.inputTokens += u.input_tokens ?? 0; sum.outputTokens += u.output_tokens ?? 0;
    sum.cache.read += u.cache_read_input_tokens ?? 0;
    sum.cache.write5m += u.cache_creation?.ephemeral_5m_input_tokens ?? (u.cache_creation_input_tokens ?? 0);
    sum.cache.write1h += u.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    for (const b of Array.isArray(e.message.content) ? e.message.content : []) if (b.type === "tool_use" && b.name) sum.toolCalls[b.name] = (sum.toolCalls[b.name] ?? 0) + 1;
    sum.model ??= e.message.model; sum.first ??= e.timestamp; sum.last = e.timestamp;
  }
  sum.seconds = sum.first && sum.last ? Math.max(0, (new Date(sum.last) - new Date(sum.first)) / 1000) : 0;
  return sum;
}

// --- Which sessions belong to an incident -----------------------------------------------------
// A session joins an incident by name, not by where it happens to be: `currentRunFolder` answers
// "is this directory under an incident", which is true of every session the human opens in that
// repository, including ones with nothing to do with the run. The marker says which sessions are
// actually seats, so `hooks/noscope-gate.sh` can let every other session past without starting
// node. One empty file per session, named by the session id, holding the run folder it joined.
//
// `hooks/noscope-gate.sh` reads this directory too, and hardcodes the path because resolving it
// through node would cost the 47ms the gate exists to avoid. This is the only place the two
// agree by duplication rather than by import, and `tests/scenario.sh` asserts they still match.
export const SESSIONS_DIR = join(NOSCOPE_HOME, "sessions");
/**
 * The session this process is running under: Claude Code puts it in the environment of every
 * command it runs, so a script invoked through Bash knows which session asked for it without
 * the model having to say. NOSCOPE_SESSION_ID overrides it, which is how the scenario joins and
 * leaves without touching the session that runs the test.
 */
export function sessionId() {
  return process.env.NOSCOPE_SESSION_ID || process.env.CLAUDE_CODE_SESSION_ID || null;
}
export function sessionMarkerPath(id) { return join(SESSIONS_DIR, String(id).replace(/[^A-Za-z0-9._-]/g, "_")); }
/** Marks a session a seat of the incident at `folder`. Returns the session id, or null when none is knowable. */
export function joinSession(folder, id = sessionId()) {
  if (!id) return null;
  mkdirSync(SESSIONS_DIR, { recursive: true });
  pruneSessions();
  writeFileSync(sessionMarkerPath(id), `${folder}\n`);
  return id;
}
/**
 * Drops markers no ending will ever clear: a session killed mid-incident leaves one behind, and
 * its run folder is deleted or its incident finished without `clearSessions` ever running. They
 * accumulate, and a directory that is never empty costs every unrelated session on the machine
 * the second tier of the gate rather than the first. Joining is rare, so this runs there.
 */
export function pruneSessions() {
  let n = 0;
  for (const { sessionId: id, folder } of joinedSessions()) {
    const statePath = join(folder, "incident.json");
    let stale = !existsSync(statePath);
    if (!stale) { try { stale = ["satisfied", "failed", "stopped"].includes(JSON.parse(readFileSync(statePath, "utf8")).incident.status); } catch { stale = false; } }
    if (stale) { try { rmSync(join(SESSIONS_DIR, id)); n++; } catch {} }
  }
  return n;
}
/** Drops one session's marker. */
export function leaveSession(id = sessionId()) {
  if (!id) return null;
  try { rmSync(sessionMarkerPath(id)); } catch {}
  return id;
}
/** Drops every marker naming this run folder; the end of an incident stands its seats down. */
export function clearSessions(folder) {
  let n = 0;
  try {
    for (const name of readdirSync(SESSIONS_DIR)) {
      const p = join(SESSIONS_DIR, name);
      try { if (readFileSync(p, "utf8").trim() === folder) { rmSync(p); n++; } } catch {}
    }
  } catch {}
  return n;
}
/** The sessions currently joined, as [{sessionId, folder}]. */
export function joinedSessions() {
  try {
    return readdirSync(SESSIONS_DIR).map((name) => ({ sessionId: name, folder: readFileSync(join(SESSIONS_DIR, name), "utf8").trim() }));
  } catch { return []; }
}
