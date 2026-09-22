---
name: noscope-start
version: "0.1.0"
updated: "2026-09-21"
description: "Start a noscope incident from the session you are in: take the objective, ask the two run questions here, and launch the directing session in a new terminal tab, which then runs /noscope-run and the whole flow without you. Invoke as /noscope-start <objective>, optionally followed by lines starting constraints:, priorities: or repo:. Slash-command only."
---

# noscope-start

You are not the IC; you launch it. The IC runs in its own session so its context is the
incident's alone and this conversation continues.

| Step | What you do |
|---|---|
| 1. Take the invocation | As `/noscope-run` does: the objective on the first line; `constraints:`, `priorities:`, `repo:` lines as given. The working directory is `repo:` or this session's cwd. |
| 2. Ask the two questions here | The same two as `/noscope-run` section 2, in one call of the question tool: run until done or stop at the cutoff (compute the time from `loadConfig()` and `cutoffBefore()` in `${CLAUDE_PLUGIN_ROOT}/scripts/incident_lib.mjs` so the option shows it), and attended or unattended. Say what each means in the option text; the IC will not ask again. |
| 2a. If the IC's model is `smallest` | The IC's model must be known before its session can be launched, so open the incident and run the size-up here: `F=$(node S/incident_init.mjs <working-directory> --objective … --mode … --attended …)`, then `node S/incident_brief.mjs sizeup $F/incident.json`, spawn `noscope:sizeup` on Haiku with it in the foreground (the seat hook applies the briefing and routes every `smallest` seat), and read `models.ic` from `$F/run.json`: that is the model to launch on. Add a `folder: $F` line to the prompt so `/noscope-run` skips its own opening and size-up. |
| 3. Write the IC's first prompt | To `~/.claude/noscope/start-<name>.txt`, where `<name>` is `noscope-<project>-ic1` (`<project>` the working directory's basename; `ic2` if that name is already in `ListAgents`): the `/noscope-run` invocation with the objective on the first line, then the `constraints:`, `priorities:`, `repo:`, `mode:` and `attended:` lines. Nothing else: `/noscope-run` orients itself. |
| 4. Launch | `bash ${CLAUDE_PLUGIN_ROOT}/scripts/launch-session.sh start <working-directory> <icModel> <name> ~/.claude/noscope/start-<name>.txt`, where `<icModel>` is `icModel` from `~/.claude/noscope/config.json` (`node -e` with `loadConfig()` from `S/incident_lib.mjs`; default `claude-sonnet-5`), or the routed model from step 2a. On a Mac with Warp a red tab opens under that name running `claude --model <icModel> --name <name> --remote-control <name>` with the prompt; The script waits for the new session to come up; if it exits non-zero the tab never ran, and it prints the command to run by hand, which you give to the human on a line of its own. Where Warp is absent it prints the same command. |
| 5. Report | One line: the tab's name, and that the IC will open blue tabs named `noscope-<id>-<unit>` for its leaders. The IC is a peer session: `ListAgents` shows it, `SendMessage` to its name reaches it, and it is visible from claude.ai and the phone through Remote Control. In an unattended run its morning report lands in the incidents repository; in an attended one its questions appear in its own tab. |

The human can still open the tab and type `/noscope-run` there; this skill is the same start from
here.
