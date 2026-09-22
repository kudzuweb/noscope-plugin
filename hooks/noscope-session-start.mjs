#!/usr/bin/env node
// SessionStart: if the working directory has an open incident, say so, so a resumed or
// successor session (and the heartbeat's tick) knows to run /noscope-resume.
import { readInput, openIncident, ENDED, ROLE, inflight, markUp } from "./lib.mjs";
import { joinSession } from "../scripts/incident_lib.mjs";
const input = readInput();
// A tab the launcher opened says it is up, so the launcher can tell a session that started
// from one that never ran (a shell that ate the command, a trust dialog, a crash on boot).
// This is the first thing the session does, before any incident is read: a `start` tab has no
// run folder yet, and a tab that dies later still proves it booted.
markUp(process.env.NOSCOPE_SEAT, input.session_id);
const inc = openIncident(input.cwd);
if (!inc) process.exit(0);
const s = inc.state.incident;
// A tab the launcher opened carries the run it was opened for, so it is a seat before it has
// read a word, and the gate lets its hooks run. A session that merely sits in a directory with
// an incident open is not marked: it is told below that the incident exists, and joins only by
// taking command with /noscope-resume. This hook itself is never gated, which is what lets it
// reach a session that does not yet know any of this.
if (process.env.NOSCOPE_RUN && !ENDED.has(s.status)) joinSession(inc.folder, input.session_id);
if (ROLE === "ic") inflight(inc.folder, input.session_id, -1e9);   // a fresh session has no seat in flight
if (ENDED.has(s.status)) process.exit(0);
if (ROLE === "leader") { process.stdout.write(`[noscope] This session leads unit ${process.env.NOSCOPE_UNIT ?? "?"} of incident ${s.id} at ${inc.folder}; run /noscope-lead ${inc.folder} ${process.env.NOSCOPE_UNIT ?? ""}\n`); process.exit(0); }
// Only the Incident Commander is told to take command. Naming the seats that must not be told
// is the wrong way round: this hook told every role but leader to run /noscope-resume, so the
// refusal_fallback task session added in 0.14.0 was being sent to take command of the incident
// it was meant to do one task for. A role this hook has never heard of now says what it is and
// stops, and only ROLE "ic" reaches the line below.
if (ROLE !== "ic") { process.stdout.write(`[noscope] This session is the ${ROLE} seat of incident ${s.id} at ${inc.folder}${process.env.NOSCOPE_TASK ? `, running task ${process.env.NOSCOPE_TASK}` : ""}. Your first prompt says what to do; command stays with the session run.json names.\n`); process.exit(0); }
if (process.env.NOSCOPE_START) { process.stdout.write(`[noscope] An earlier incident (${s.id}, ${s.status}${inc.run?.paused ? ", paused" : ""}) exists for this directory at ${inc.folder}. It is not yours: /noscope-run opens a new one and leaves it alone.\n`); process.exit(0); }
process.stdout.write(`[noscope] Incident ${s.id} is ${s.status} at ${inc.folder} (period ${inc.state.period.number}; ${inc.run?.attended === false ? "unattended" : "attended"}${inc.run?.paused ? `; paused: ${inc.run.paused}` : ""}). To continue it, run /noscope-resume ${inc.folder}\n`);
