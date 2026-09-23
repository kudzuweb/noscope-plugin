---
name: noscope-handoff
version: "0.1.0"
updated: "2026-09-21"
description: "Hand command of the open noscope incident to a fresh session: write and validate the HandoffDocument, record the transfer, pause the run, move the heartbeat, launch the successor tab running /noscope-resume, and stop. Invoke as /noscope-handoff; the plugin's compaction guard also orders it when context crosses the threshold. Slash-command only."
---

# noscope-handoff

Command passes from this session to a fresh one. Everything the successor needs is in the
record, so this is short: the `HandoffDocument` is your reading of where the incident stands,
not a copy of the state. `S` is `${CLAUDE_PLUGIN_ROOT}/scripts`, `F` the run folder
(`node ${CLAUDE_PLUGIN_ROOT}/scripts/incident_current.mjs` prints it).

| Step | What you do |
|---|---|
| 0. Commit the record | `git -C <incidentsDir> add <project>/<id> && git -C <incidentsDir> commit -q -m "<project> <id>: handoff"`, so the successor starts from a committed folder. |
| 1. Finish nothing new | Do not start a task or call a leader. A seat still running finishes on its own, and its result reaches the record through the hooks whether or not this session is alive. | Ask for the shape rather than working from the protocol's field list: `node ${CLAUDE_PLUGIN_ROOT}/scripts/incident_brief.mjs shape HandoffDocument` prints it with the instruction for each field in place of its value, the same way every briefed seat is handed what it returns.
| 2. Write the document | `$F/handoff.json` as a `HandoffDocument` (its fields are in the protocol's Formats section): the period's objectives and priorities and why; every active unit with where it stands and what it waits on, naming its leader's session name (``$(node S/incident_name.mjs $F leader <unit-id>)``); your hypothesis with the claim ids it rests on; what you set aside and why; your next move and what would change it. Then `node S/incident_validator.mjs handoff $F/incident.json $F/handoff.json` and fix every `REJECT`. |
| 3. Record and pause | `node S/incident_apply.mjs handoff $F/incident.json $F/handoff.json `$(node S/incident_name.mjs $F ic <n>)`` where `n` is one more than the count under `sessions` in `run.json`, so the successor's name carries its turn and never collides with the session handing over; then `node S/incident_apply.mjs run $F/incident.json paused '"handoff to `$(node S/incident_name.mjs $F ic <n>)`"'`. The pause is what lets this session stop: the loop hook stops pushing back. |
| 4. Move the heartbeat | If `run.json` names a `heartbeat.cronId`, `CronDelete` it and `node S/incident_apply.mjs run $F/incident.json heartbeat.cronId null`; the successor creates its own. |
| 5. Launch the successor | `bash S/launch-session.sh ic $F <this session's model id> `$(node S/incident_name.mjs $F ic <n>)``. On a Mac with Warp it opens a tab running `claude --model … --name `$(node S/incident_name.mjs $F ic <n>)` --remote-control … "You are the Incident Commander taking command of noscope incident <id>… Run /noscope-resume $F"`. The launcher waits for the successor to come up and exits non-zero if it never does, printing that command and saying the decision is yours. Make it: in an attended run give the human the command on a line of its own and stop. In an unattended run do not stop — command has not transferred, so you still hold it: clear the pause you set, say in the record that the successor could not be launched, and go on with the incident until your context forces the handoff again or the cutoff ends the run. An incident nobody holds is worse than one held by a session running short of room. Elsewhere it prints the same command. In an unattended run nobody is watching, and the launch is still right: the successor resumes and recreates the heartbeat. |
| 6. Stop | Say in one line that command passed to ``$(node S/incident_name.mjs $F ic <n>)`` and that the record at `$F` is complete. Then stop. The unit leaders are sessions of their own and keep running; the successor introduces itself to each by message when it resumes. |
