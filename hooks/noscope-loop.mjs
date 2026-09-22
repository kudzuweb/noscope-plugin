#!/usr/bin/env node
// Stop in the IC's session: while the incident is open and incident_next.mjs has work, the
// stop is blocked with what is next, so the cycle continues without a human prompt. It lets the
// session stop when the incident has ended, is blocked on a question, is paused (a handoff),
// has passed its cutoff, or when the same next-step has been pushed back three times running.
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readInput, openIncident, ENDED, run, out, ROLE, inflight, inflightPath } from "./lib.mjs";

if (ROLE !== "ic") process.exit(0);          // a leader session idles between messages
const input = readInput();
if (input.agent_id || input.stop_hook_active) process.exit(0);
const inc = openIncident(input.cwd);
if (!inc) process.exit(0);
const { state, run: runCfg, statePath, hooksDir } = inc;
const status = state.incident.status;
if (ENDED.has(status) || status === "blocked") process.exit(0);
if (runCfg?.paused) { out({ systemMessage: `[noscope] run paused: ${runCfg.paused}` }); process.exit(0); }
// A seat this session spawned is still working; its stop wakes the session. A count untouched for
// thirty minutes is a seat that died without stopping, and no longer holds the session.
if (inflight(inc.folder, input.session_id) > 0) {
  let at = 0; try { at = new Date(JSON.parse(readFileSync(inflightPath(inc.folder, input.session_id), "utf8")).at).getTime(); } catch {}
  if (Date.now() - at < 30 * 60 * 1000) process.exit(0);
  inflight(inc.folder, input.session_id, -1e9);
  out({ systemMessage: "[noscope] a seat spawned by this session has not stopped in thirty minutes; treating it as lost and continuing" });
}
if (runCfg?.mode === "cutoff" && runCfg.cutoffAt && new Date() >= new Date(runCfg.cutoffAt)) {
  out({ systemMessage: `[noscope] the cutoff ${runCfg.cutoffAt} has passed; the incident stays open for /noscope-resume` }); process.exit(0);
}
const next = run("incident_next.mjs", [statePath]);
let n; try { n = JSON.parse(next.out); } catch { process.exit(0); }
// Work the IC can do now: tasks to start, leaders to call, or its own turn when nothing is in
// flight. While seats are running and nothing is startable, the IC waits for their endings
// (the leaders message it); pushing it then only buys idle turns.
const running = (state.tasks ?? []).filter((t) => t.status === "running").length;
const work = n.start.length + n.call.length + (running === 0 ? n.ic.length : 0);
if (!work) process.exit(0);

// The key includes the log's length: a record that moved is a new state, and only the same
// next-step pushed back three times with nothing landing in between counts as a loop.
const logLines = (() => { try { return readFileSync(join(inc.folder, "log.jsonl"), "utf8").split("\n").length; } catch { return 0; } })();
const key = createHash("sha1").update(next.out + "#" + logLines).digest("hex");
const loopPath = join(hooksDir, "loop.json");
const loop = existsSync(loopPath) ? JSON.parse(readFileSync(loopPath, "utf8")) : { key: null, n: 0 };
const same = loop.key === key ? loop.n + 1 : 1;
writeFileSync(loopPath, JSON.stringify({ key, n: same }));
if (same > 3) { out({ systemMessage: `[noscope] the same next step was pushed back three times; stopping so a human can look: ${next.out.slice(0, 400)}` }); process.exit(0); }
out({ decision: "block", reason: `[noscope] The incident is open and incident_next.mjs has work; continue the cycle (/noscope-run section 4). Next:\n${next.out}` });
