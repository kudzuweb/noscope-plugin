#!/usr/bin/env node
// Stop, in the IC's and every leader's session: logs the turn that just ended as a call, from
// the session's own transcript (every assistant message carries its usage), counting only the
// messages after the last one logged for this session. So a session's spend is in the record
// the same as an agent seat's, and the After Action Review prices the whole run.
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { readInput, openIncident, ENDED, writeJson, ROLE, logCall } from "./lib.mjs";
import { usageOfTranscript } from "../scripts/incident_lib.mjs";

const input = readInput();
if (input.agent_id) process.exit(0);                       // an agent seat is logged by noscope-seat-stop
const inc = openIncident(input.cwd);
// An ended incident is a receipt. Without this, any session whose directory still resolves to
// a finished run keeps logging its turns into that record and inflating its spend, which is
// exactly what happened to run 002 on 2026-09-22 after the incident was satisfied.
if (!inc || ENDED.has(inc.state.incident.status)) process.exit(0);
if (!input.transcript_path || !existsSync(input.transcript_path)) process.exit(0);
const cursorPath = join(inc.hooksDir, `turns-${input.session_id ?? "session"}.json`);
const cursor = existsSync(cursorPath) ? JSON.parse(readFileSync(cursorPath, "utf8")) : { lastUuid: null };
const u = usageOfTranscript(input.transcript_path, cursor.lastUuid);
if (!u.turns) process.exit(0);
const id = ROLE === "leader" ? (process.env.NOSCOPE_UNIT ?? "") : "";
logCall(inc.statePath, ROLE, u, id);
// The transcript path is kept so a stalled seat can be asked why without guessing where its
// transcript lives: incident_watch.mjs reads the last thing this session said from it.
writeJson(cursorPath, { lastUuid: u.lastUuid, at: new Date().toISOString(), sessionId: input.session_id ?? null, transcriptPath: input.transcript_path ?? null, role: ROLE, unit: id || null });
process.exit(0);
