#!/usr/bin/env node
// The name a session runs under. A name is an address here — the Incident Commander finds its
// leaders by name in `ListAgents` and messages them there — so it is built in this one place
// and never composed by hand at a call site. Launching a seat and looking one up both run this
// and get the same string.
//
//   node incident_name.mjs <run folder> ic     [n]
//   node incident_name.mjs <run folder> leader <unit-id>
//   node incident_name.mjs <run folder> task   <task-id>
//
// With --title it also sets the terminal's title to the name, by writing the OSC escape to
// /dev/tty rather than to stdout, so the name can still be captured from a command substitution.
// A session that ran /noscope-run in place was never launched with --name and would otherwise sit
// in the tab bar under whatever it was called before it took command.
//
// The shape is role, incident, which one, and what it is about:
//
//   IC-014-scroll-after-delete          the Incident Commander of incident 014
//   UL-014-1-which-container-scrolls    the leader of that incident's first unit
//   TSK-014-3-reproduce-on-local        a refused task rerun as a session
//
// The trailing words come from that seat's own objective, so a tab bar full of sessions reads
// as the work rather than as a list of ids. They are decoration for a human: everything that
// identifies the seat is in the part before them, and two seats can never collide on it.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The objective, as a few words safe for a session name, a Warp tab and a shell argument.
 * Whole words only: a budget cut mid-word gives `establish-by-observation-wha`, which reads as
 * a mistake rather than as a label.
 */
function slug(text, budget = 22) {
  const skip = new Set(["the", "a", "an", "of", "to", "in", "on", "for", "and", "is", "it", "why", "that", "which", "when", "what", "by"]);
  const words = String(text ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(/\s+/).filter((w) => w && !skip.has(w));
  const out = [];
  let used = 0;
  for (const w of words) {
    if (out.length && used + 1 + w.length > budget) break;
    if (!out.length && w.length > budget) { out.push(w.slice(0, budget)); break; }
    used += (out.length ? 1 : 0) + w.length;
    out.push(w);
  }
  return out.join("-");
}
/** u01 -> 1, command -> command; anything else is passed through with its punctuation dropped. */
function unitNumber(unitId, incidentId) {
  const tail = String(unitId ?? "").replace(new RegExp(`^${incidentId}-`), "");
  const m = tail.match(/^u0*(\d+)$/);
  return m ? m[1] : tail.replace(/[^A-Za-z0-9]/g, "");
}

const argv = process.argv.slice(2).filter((a) => a !== "--title");
const setTitle = process.argv.includes("--title");
const [folder, role, id] = argv;
const statePath = folder ? join(folder, "incident.json") : null;
if (!statePath || !existsSync(statePath)) { console.error("usage: incident_name.mjs <run folder> <ic|leader|task> [id]; see the header"); process.exit(2); }
const state = JSON.parse(readFileSync(statePath, "utf8"));
const incidentId = state.incident.id;

let name;
if (role === "ic") {
  // A successor after a transfer of command takes the same seat, so it takes the same name with
  // its turn on it: the predecessor may still be listed while it writes its last line, and two
  // live sessions answering to one name is the one collision that matters here.
  const n = Number(id ?? 1);
  name = `IC-${incidentId}${n > 1 ? `-${n}` : ""}-${slug(state.incident.objective)}`;
} else if (role === "leader") {
  const u = state.units.find((x) => x.id === id);
  if (!u) { console.error(`no unit ${id} in ${statePath}`); process.exit(2); }
  // The command unit is the Incident Commander's own; it has no leader session beside the IC,
  // so asking for its name gives the IC's rather than inventing a second seat for one session.
  name = u.parentId === null || u.type === "ic"
    ? `IC-${incidentId}-${slug(state.incident.objective)}`
    : `UL-${incidentId}-${unitNumber(u.id, incidentId)}-${slug(u.objective)}`;
} else if (role === "task") {
  const t = state.tasks.find((x) => x.id === id);
  if (!t) { console.error(`no task ${id} in ${statePath}`); process.exit(2); }
  name = `TSK-${incidentId}-${unitNumber(t.id, incidentId).replace(/^t0*/, "")}-${slug(t.objective)}`;
} else { console.error("role is ic, leader or task"); process.exit(2); }

// launch-session.sh accepts letters, digits, dot, underscore and dash, and a seat with no
// objective yet would otherwise end in a bare dash.
const final = name.replace(/[^A-Za-z0-9._-]/g, "").replace(/-+$/, "");
if (setTitle) {
  // To the terminal, never to stdout: the caller is usually reading the name from here.
  try { writeFileSync("/dev/tty", `\u001b]0;${final}\u0007`); } catch {}
}
console.log(final);
