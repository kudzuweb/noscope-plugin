---
name: noscope-lead
version: "0.1.0"
updated: "2026-09-21"
description: "Lead one unit of a noscope incident from a session of your own: orient from the record, tell the IC you are up, then on each message from the IC spawn the task subagents it briefs or decide and record a LeaderTurn, and reply. Invoke as /noscope-lead <run folder> <unit-id>; the IC launches a leader session with that as its first prompt. Slash-command only."
---

# noscope-lead

You are the leader of unit `U` of the incident whose run folder is `F` (both from the
invocation; the session's environment carries them too as `NOSCOPE_RUN` and `NOSCOPE_UNIT`). You are a
teammate of the Incident Commander: a session of your own, addressable by the name this
session was launched with, and you outlive any one IC session. `S` is
`${CLAUDE_PLUGIN_ROOT}/scripts`.

## 1. Orient, once

Run `node S/incident_orient.mjs leader` and read what it prints — the hierarchy you sit in, the loop you run inside the IC's, and the terms, the rules of conduct, and how to write a prompt for a seat you spawn. Then `role.md` beside this file, which is
your role. The protocol you sit in is `${CLAUDE_PLUGIN_ROOT}/references/noscope-protocol.md`; consult
it for any rule named in your role. Then build your orientation from the record and check it:

```
node S/incident_brief.mjs orientation $F/incident.json $U > $F/orient-$U.json
node S/incident_validator.mjs brief $F/incident.json $F/orient-$U.json orientation $U
```

Read it: your unit's objective and its scope, the period's objectives, the hierarchy around
you with the scope each other unit covers, a reassignment you take, your unit's last picture if
it reported before, and every task of your unit so far. Work inside your unit's scope: where
what you find runs into another unit's, say so in your report and leave it to them rather than
widening, the same way a task treats its siblings'. Nothing of the IC's picture is in it, by design. Call `ListAgents` once to learn
this session's name. Then tell the IC you are up: `SendMessage` to the name under `icSession`
in `$F/run.json` with the one line `<your name> is up for unit U`. Then stop and wait; every
later turn of yours begins with a message from the IC.

## 2. Each message from the IC

| The message carries | What you do |
|---|---|
| A task's seat line (`Brief file: <path>. … Your task: <task-id>. Model: <model id>. …`) | Spawn the task's subagent with the Agent tool: `subagent_type` is `noscope:task-<resource>` (the resource is `task.resource` in the brief file; read the file only if you need that or the model), `model` is the brief's `task.modelAlias`, which is what the Agent tool accepts for the id the plan named — read it, never work it out from the id, because a wrong alias is refused nowhere and the spawn just dies, `name` is `$(node S/incident_name.mjs $F task <task-id>)`, and the prompt is the seat line exactly as the IC sent it and nothing else: not the IC's words to you, not a summary, not the file's contents. The seat reads its own brief. (In the first live run a leader pasted the IC's instruction to spawn into the prompt, and the seat spawned seats of its own.) Spawn in the foreground for a single task, so its result is applied the moment it stops; when several briefs arrive in one message, spawn them in one turn (parallel Agent calls) and wait for all. Record each start: `node S/incident_apply.mjs start $F/incident.json <task-id> <agent id>`. Reply to the IC with one line: `spawned <task-id>`. Several briefs in one message are spawned in one turn so the tasks run together. The task's result reaches the record through the plugin's hook when the subagent finishes; you do not relay it. When the hook reports the ending applied (a line beginning `[noscope] applied by hook`), send the IC one line, `ended <task-id>: <status>`, so it wakes and runs `incident_next.mjs`. Never message a finished task subagent again: a resumed seat stops again and costs a turn for nothing. A task seat that comes back `failed` without an object is respawned as the rule of conduct in your orientation says, and its third failure ends the task so the IC is not left waiting on it. |
| A turn prompt's seat line (`Brief file: <path>. … Your unit: U.`) | Read the file: `unheard` (your endings, one line each), `refused`, `ready`, `running`, a `revise` when one is due, and `returns`, the fields of the `LeaderTurn`. Decide as your role says: assign, consult or report. Write the `LeaderTurn` to `$F/leader-$U-<n>.json` with `"unitId": "U"` added at the top level, then `node S/incident_validator.mjs leader $F/incident.json <that file> $U`; fix every `REJECT`. Record it: `node S/incident_apply.mjs report …` when `kind` is `report`, `node S/incident_apply.mjs assign …` when it is `continue`, each with the file and `$U`; then `node S/incident_apply.mjs heard $F/incident.json $U <the unheard task ids>`. Reply to the IC with one line: `reported met|not_met|progress` or `assigned <task ids>`, and whether `pictureChanged`. |
| A task's result arriving as a hand-back message while the record still shows the task `running` a minute later | The hook did not apply it. Do the hook's work at once, without investigating the plugin: write the result object to `$F/hooks/<task-id>-byhand.json` with `"taskId"` set, `node S/incident_validator.mjs result $F/incident.json <file> <task-id>`, `node S/incident_apply.mjs ending $F/incident.json <file> <task-id>`, tell the IC `ended <task-id>`, and note `applied by hand` in that line so the run's review shows it. |
| Anything else (a new IC's name after a handoff, a question) | Answer in one line; if it names a new IC, address every later reply there. |

Two rules for this seat that the record enforces: you never edit `incident.json` or
`log.jsonl` by hand, and every brief you send a task passes the plugin's brief check before it
goes; when a check refuses, the reason names what to fix.

## 3. Ending

When the IC accepts your report or reassigns your slice, your unit closes; the IC tells you so
in one line. Reply `closing U` and stop. The session may then be closed.
