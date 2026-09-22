#!/usr/bin/env node
// PostToolUse on Agent, SendMessage and Bash in the IC's session: reports what the seat hooks
// applied since the last report, and after anything that changes the record, what
// incident_next.mjs says is next. Silent inside subagents and outside an incident.
import { join } from "node:path";
import { readInput, openIncident, ENDED, unreported, run, out, writeJson, ROLE, logRejected, inflight, failedCall } from "./lib.mjs";
const input = readInput();
if (input.agent_id) process.exit(0);
const inc = openIncident(input.cwd);
if (!inc || ENDED.has(inc.state.incident.status)) process.exit(0);
if (ROLE !== "ic") {                          // a leader session: report only what its task hooks applied
  const lines = unreported(inc.folder, "leader").map((e) => `applied by hook (${e.seat}): ${e.result}`);
  if (lines.length) out({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `[noscope] ${lines.join("\n")}` } });
  process.exit(0);
}
// The IC's session: remember it, so the launcher gives leader sessions the same permission mode.
writeJson(join(inc.hooksDir, "ic.json"), { sessionId: input.session_id ?? null, permissionMode: input.permission_mode ?? null, at: new Date().toISOString() });
const cmd = String(input.tool_input?.command ?? "");
// A seat spawn that failed as a tool call (an API error, a refused spawn) never stops, so it is counted back out here.
if (input.tool_name === "Agent" && /^noscope[:-]/.test(String(input.tool_input?.subagent_type ?? ""))) {
  const r = input.tool_response; const text = typeof r === "string" ? r : JSON.stringify(r ?? "");
  if ((r && r.is_error) || failedCall(text)) inflight(inc.folder, input.session_id, -1);
}
// A validator run by hand that rejected: log the REJECT lines against the record.
const v = /incident_validator\.mjs\s+(plan|command|leader|result|briefing|review|handoff|brief)\b/.exec(cmd);
if (input.tool_name === "Bash" && v) {
  const text = typeof input.tool_response === "string" ? input.tool_response : JSON.stringify(input.tool_response ?? "");
  const lines = text.split(/\\n|\n/).filter((l) => l.startsWith("REJECT"));
  if (lines.length) logRejected(inc.statePath, v[1], lines.join("\n"));
}
const touchesRecord = input.tool_name !== "Bash" || /incident_apply\.mjs|incident_init\.mjs/.test(cmd);
if (!touchesRecord) process.exit(0);
const lines = unreported(inc.folder).map((e) => `applied by hook (${e.seat}): ${e.result}${e.call ? `; ${e.call}` : ""}`);
const next = run("incident_next.mjs", [inc.statePath]);
let n; try { n = JSON.parse(next.out); } catch { n = null; }
const summary = n ? [
  n.start.length ? `start: ${n.start.map((s) => `${s.taskId} (${s.resource}, ${s.how})`).join("; ")}` : null,
  n.call.length ? `call: ${n.call.map((c) => `${c.unitId} because ${c.reasons.join(" and ")}`).join("; ")}` : null,
  n.ic.length ? `you: ${n.ic.join("; ")}` : null,
  n.blocked?.length ? `blocked: ${JSON.stringify(n.blocked)}` : null,
  n.held?.length ? `held: ${n.held.map((h) => `${h.taskId} (${h.why})`).join("; ")}` : null,
  n.stale?.length ? `stale: ${n.stale.map((h) => `${h.taskId} (${h.why})`).join("; ")}` : null,
  n.waiting?.length ? `waiting: ${n.waiting.map((w) => `${w.unitId} on ${w.on}`).join("; ")}` : null,
].filter(Boolean).join("\n") : next.out.trim();
if (!lines.length && !summary) process.exit(0);
out({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: `[noscope] ${[...lines, `next: ${summary || "nothing to start or call"}`].join("\n")}` } });
