#!/usr/bin/env node
// Which sessions are seats of an incident. A marker under ~/.claude/noscope/sessions/ names one
// session and the run folder it joined, and hooks/noscope-gate.sh runs the plugin's hooks only
// for a session that has one. Without this, membership is "this session's directory is under a
// repository with an open incident", which is true of every session the human opens there.
//
//   node incident_session.mjs join  <run folder> [session-id]   this session is a seat of that run
//   node incident_session.mjs leave [session-id]                it is not, or no longer
//   node incident_session.mjs list  [run folder]                the sessions joined, one per line
//   node incident_session.mjs prune                             drops markers whose run is gone or ended
//
// The session id comes from the environment (CLAUDE_CODE_SESSION_ID, which Claude Code sets on
// every command it runs; NOSCOPE_SESSION_ID overrides it) unless one is given. `incident_init.mjs`
// joins the session that opens an incident and `incident_apply.mjs` drops every marker when the
// incident ends, so `join` is for a session taking command of a run it did not open —
// /noscope-resume — and for repairing a run whose markers were lost.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { joinSession, leaveSession, joinedSessions, pruneSessions, sessionId, SESSIONS_DIR } from "./incident_lib.mjs";

const [mode, a, b] = process.argv.slice(2);

if (mode === "join") {
  if (!a || !existsSync(join(a, "incident.json"))) { console.error("join needs a run folder holding incident.json"); process.exit(2); }
  const id = joinSession(a, b ?? sessionId());
  if (!id) { console.error("no session id: pass one, or set CLAUDE_CODE_SESSION_ID"); process.exit(2); }
  console.log(`session ${id} is a seat of ${a}; this session's noscope hooks run from here on`);
}
else if (mode === "leave") {
  const id = leaveSession(a ?? sessionId());
  if (!id) { console.error("no session id: pass one, or set CLAUDE_CODE_SESSION_ID"); process.exit(2); }
  console.log(`session ${id} left; its noscope hooks stand down`);
}
else if (mode === "list") {
  const rows = joinedSessions().filter((r) => !a || r.folder === a);
  if (!rows.length) { console.log(`no session has joined an incident (${SESSIONS_DIR})`); }
  else for (const r of rows) console.log(`${r.sessionId}\t${r.folder}`);
}
else if (mode === "prune") {
  const n = pruneSessions();
  console.log(n ? `${n} marker(s) dropped: their run folder is gone or their incident has ended` : "nothing to prune");
}
else { console.error("usage: see the header of incident_session.mjs"); process.exit(2); }
