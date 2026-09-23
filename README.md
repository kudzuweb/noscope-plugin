# noscope-plugin

A Claude Code plugin for work too big to hold in one session.

One session directs and never does the work itself. It sets each round's objectives, and a
planner proposes how to meet them. Each slice of the problem gets a session of its own, in its
own tab, which assigns the actual work to subagents and reports back against its slice. Every
result comes back as evidence, or as a claim that says what it rests on and whether anyone
observed it. The directing session keeps one written picture of what is true so far, rules on
each report, and closes with a review priced from every model call the run made.

The rules the sessions follow are in `references/noscope-protocol.md`. The parts that need no
judgment are scripts and hooks in `scripts/` and `hooks/`, so a model call is only ever spent
on a decision.

## Install

Use the first route unless you have a reason not to. From a shell:

```
git clone https://github.com/kudzuweb/noscope-plugin.git
claude plugin marketplace add "$(pwd)/noscope-plugin"
claude plugin install noscope@noscope-plugin
```

Then start a new session and run `/noscope:noscope-install` in it. A plugin's skills are
namespaced by the plugin, so that is the name to type; `/noscope-install` on its own is not it.
Quote the path if it contains a space.

Which route you take does not change when the plugin's hooks do anything. A hook runs only for a
session that has joined an incident, whatever the scope: `hooks/noscope-gate.sh` stands in front
of each one and exits in about 3ms for every other session on the machine, without starting node.
Scope decides only which projects load the plugin at all.

One hook is deliberately not gated: `SessionStart` runs once when a session opens, whatever
scope you installed at, because its job is telling a session that does not know about an
incident that one exists. At user scope that is one node start, about 47ms, per session — not
per tool call.

| Route | Command | Effect |
|---|---|---|
| Register this folder as a marketplace and install from it | `claude plugin marketplace add /absolute/path/to/noscope-plugin` then `claude plugin install noscope@noscope-plugin` | Installs at user scope, so the plugin loads in every session in every project from the next start; `-s project` or `-s local` confines it to one repository instead. Outside an incident its hooks cost one short-lived `bash` and never start node, because `hooks/noscope-gate.sh` runs a hook only for a session that has joined a run. The install is a copy under `~/.claude/plugins/cache/`, so after editing this folder run `claude plugin update noscope@noscope-plugin` (and bump `version` in `plugin.json` for a release). |
| Load for one session | `claude --plugin-dir /absolute/path/to/noscope-plugin` | Nothing is installed. |
| Drop into the skills folder | `mkdir -p ~/.claude/skills && cp -R /absolute/path/to/noscope-plugin ~/.claude/skills/` | Auto-loads next session as `noscope-plugin@skills-dir`, so its skills are `/noscope-plugin:noscope-install` and not `/noscope:…`. Use one route only: installing this way as well as the first loads every skill and hook twice. |

Then, in a Claude Code session, run `/noscope-install`: it checks Node 18 and `jq`, registers the
status-line sensor the compaction guard needs (or adds it to your existing status line, with
your consent), asks where incident records go, when your workday starts, at what context percentage a
session should hand off, and which model each seat above a task runs on (the directing session and the per-slice ones Sonnet 5, the planner Opus 5 by default; `smallest` routes by the rule in the protocol), asks separately whether to suppress the folder-trust dialog for a repository while an incident
runs on it, writes `~/.claude/noscope/config.json`, writes an adapter for your terminal at
`~/.claude/noscope/open-tab.sh` if it can drive one, installs the failsafe (a launchd agent on a
Mac, and elsewhere the command to put on a timer of your own), and runs the scenario test.

The failsafe is the one part that lives outside a run, because the parts inside one cannot see a
seat that simply stops: the loop hook pushes a session that is working and the heartbeat restarts
a run that died, and a session sitting there doing nothing is neither. Every ten minutes it looks
at the runs and seats that registered themselves — a run registers when it opens and deregisters
when it ends, a seat when it joins — and reports any that has taken no turn for too long and is
waiting on nothing, with how long and why, quoted from the error that stopped it or the last thing
it said. A seat waiting on work that is running is not stalled however long it waits. Each one is
queued for the seat above it, so the Incident Commander is told the next time it does anything.
`node ${CLAUDE_PLUGIN_ROOT}/scripts/incident_daemon.mjs status` says whether it is loaded and what
it last found; `uninstall` removes it.

## Run an incident

In a session on the repository the incident concerns, either of:

```
/noscope-run Determine why the app scrolls to the bottom comment after a comment is deleted
/noscope-start Determine why the app scrolls to the bottom comment after a comment is deleted
```

`/noscope-run` makes this session the directing one. `/noscope-start` asks the two run questions
here and launches the directing session in a new tab instead, so this conversation goes on; it
is a peer session you can message by name.

### Your terminal

An incident runs as several sessions at once: the directing one in a tab, a session per slice of
the problem in tabs of their own, and a successor after a handoff. Opening those tabs is the one
thing the plugin cannot do portably. `scripts/launch-session.sh` knows
**Warp on macOS** out of the box, and `/noscope-install` can teach it your terminal.

Everywhere else the plugin still works and nothing fails silently: the launcher prints the exact
command for the session it wanted to open and exits, and the seat that called it hands you that
command to run in a new tab yourself. You get the same incident; you place the tabs.

`/noscope-install` will try to close that gap on your machine. It detects your terminal, and where
that terminal can be driven from a script it writes the launcher a case for it and tells you it
is automatic now. Where it cannot — a terminal with no scripting interface, or a remote session —
it says so plainly and tells you the manual flow is what you have, rather than leaving you to
discover it mid-incident.

The directing session asks two questions first: run until done, or stop at the cutoff (five hours before your
workday starts, so a fresh usage window is waiting); and attended (a question to you waits for
your answer) or unattended (a question blocks the incident for the morning, a heartbeat
resumes the run after a usage reset, and a handoff opens a successor tab without asking).
Then it sizes the incident up and runs rounds until the objective is met, cannot be met, or a
question blocks it. What settles a question is an observed claim; where a conclusion rests on
an inference instead, the run says which claim it is and what would have settled it. The record lives in the incidents
repository you named at install (default `~/Documents/Projects/noscope-plugin-incidents`), under
`<project>/<incident-id>/`: `incident.json`, `log.jsonl`, `run.json`, every brief, draft, turn
and result, and at the end `after-action-review.txt` and `morning-report.md`; the directing session commits
it at every turn of its own. Nothing is written into the repository the incident concerns. With `preAccept` on, the run does change one thing outside the record — the folder-trust flags for that repository in `~/.claude.json` — and puts them back as it found them when the incident ends.

| Skill | When |
|---|---|
| `/noscope-run <objective>` | Direct an incident from this session; lines `constraints:`, `priorities:`, `repo:` may follow. |
| `/noscope-start <objective>` | Start an incident from the session you are in: it asks the two run questions here and launches the directing session in a new tab, which runs the whole flow on its own. Same lines as `/noscope-run`. |
| `/noscope-resume <run folder>` | Take or retake command from the record: after a handoff, a crash, a usage reset (the heartbeat runs it) or a cutoff. |
| `/noscope-lead <run folder> <unit-id>` | The first prompt for a session that owns one slice; the launcher issues it, you never type it. |
| `/noscope-handoff` | Pass command to a fresh session; the compaction guard orders it when context runs high. |
| `/noscope-install` | Once per machine, after installing the plugin. |
| `/noscope-audit <run folder>` | What a finished run cost and what it wasted, in tables: where the bytes went, what the state carries, tokens each seat was handed against what it wrote, and the checks that fired. `--record` keeps the run's metrics as a line in `<incidentsDir>/metrics.jsonl`; `--compare` puts every recorded run in one table. Reads the record and writes only that line. |

To bound a run: it is unbounded unless you say otherwise, and `node ${CLAUDE_PLUGIN_ROOT}/scripts/incident_apply.mjs budget <run folder>/incident.json <tokens|seconds> <n|none>` sets, raises or lifts a bound at any point, including while it is running. Once a bound is spent nothing new starts and the directing session declares an outcome or waits for you to raise it. `--budget-tokens` and `--budget-seconds` on `incident_init.mjs` do the same at the start.

To stop a run: `node ${CLAUDE_PLUGIN_ROOT}/scripts/incident_apply.mjs stop <run folder>/incident.json "<why>"` marks it `stopped` and every session's hooks stand down; `/noscope-run` afterwards opens a new incident beside it, and only `/noscope-resume`, asked for in words, reopens the stopped one.

## Layout

| Path | What it is |
|---|---|
| `references/noscope-protocol.md` | The protocol: the loop at every level, the seats, the cycle, the state machine, the checklist, what is kept, and every format handed between seats. |
| `scripts/` | The runtime as tool calls: `incident_init.mjs`, `incident_validator.mjs`, `incident_apply.mjs`, `incident_next.mjs`, `incident_brief.mjs`, `incident_evidence.mjs`, `incident_review.mjs`, `incident_audit.mjs` (what a run cost and what it wasted, beside the review's account of what happened), `incident_report.mjs` (the morning report), `incident_current.mjs` (the incident open in a directory), `build_shapes.mjs` (writes `references/protocol-objects.json` from the protocol; `--check` fails when they differ), `incident_orient.mjs` (the orientation a seat is given when it is spawned, assembled from the named sections of `references/orientation.json` so the hierarchy, the loop and the rules for prompting a seat are written once and reach every seat; `--stamp` prints the file and commit to log instead, since nothing is stored per spawn), `incident_seatline.mjs` (the line that delivers a brief, built rather than typed because the brief guard reads four fields back out of it), `incident_name.mjs` (the name a session runs under, and with `--title` the terminal's title too, so a session that took command in place stops sitting in the tab bar under whatever it was called before; built in one place because a name is an address: `IC-014-scroll-after-delete`, `UL-014-1-which-container-scrolls`, `TSK-014-3-reproduce-on-local`, the trailing words taken from that seat's own objective so a tab bar reads as the work), `incident_session.mjs` (which sessions are seats of a run, so the hooks can tell them from every other session on the machine), `incident_watch.mjs` (the seats that have stopped working and are waiting on nothing: who, how long, and why in their own last words or the error that stopped them, read from what the runtime already wrote and deciding nothing; `--notify` queues each one for the seat above it), `incident_daemon.mjs` (the launchd agent that runs the watcher on a timer, through a shim in `~/.claude/noscope/` that resolves the newest installed plugin each run, because an installed plugin's path carries its version and a plist aimed into it dies at the next update), `launch-session.sh` (opens a Warp tab running a new directing session, a successor, a session for one slice, or a refused task rerun as a session on its tier's previous model, and waits for that session's own SessionStart hook to confirm it came up, retrying the open twice before it reports the command to run by hand), `incident_trust.mjs` (lends a working directory's folder-trust dialog for the length of an incident, so an unattended tab does not wait on it, and puts the previous setting back when the last run holding it ends), the shared `incident_lib.mjs` (which also holds the list-price table), and `state.example.json`, the state's shape. |
| `skills/noscope-start/` | Launching the directing session from wherever you are. |
| `skills/noscope-run/` | The directing session's skill: `SKILL.md` is the cycle as this plugin runs it, `role.md` its role text. |
| `skills/noscope-handoff/` | The transfer of command to a fresh session. |
| `skills/noscope-lead/` | The skill for a session that owns one slice: `SKILL.md` is what it does on each message from the directing session, `role.md` its role text. One is launched per slice with `scripts/launch-session.sh leader`. |
| `skills/noscope-resume/` | Taking command from the record. |
| `skills/noscope-install/` | The per-machine setup: prerequisites, sensor, configuration, tests. |
| `skills/noscope-audit/` | Auditing a finished run for cost and waste. |
| `references/protocol-objects.json` | The object each seat returns, in the shape it returns it in: every value is the instruction for that field, so a seat fills a shape instead of building one from a field list. Generated from the protocol by `scripts/build_shapes.mjs`; the scenario fails if the two have drifted. |
| `references/orientation.json` | The parts of a seat's orientation, as named sections: the hierarchy and what each seat owns, the loop, and how to write a prompt for a seat you spawn. Each seat kind lists the sections it gets, so a rule lives in one place and reaches every seat on its next spawn. |
| `agents/` | The five agent seats: `sizeup` (Haiku), `planner` (Opus), `task-investigate`, `task-reproduce`, `task-interpret` (the model the plan names). A session that owns a slice is not an agent but a session of its own (`skills/noscope-lead/`). Each body is the seat's role text from the noscope TypeScript runtime, its `rounds-4-5` branch at f009208, adapted to this plugin: the runtime is the scripts and hooks, the validator is `incident_validator.mjs`, no grant language, models as ruled, and a seat that has no reason to write says so in its `tools` rather than only in its prose: the planner is `Read` alone, plus how the seat returns its object. |
| `hooks/` | The runtime as hooks (`hooks.json`, every handler in exec form — an executable and an argument list, so no shell tokenizes a model id or an apostrophe on its way to a hook), each one reached through `noscope-gate.sh`, which runs it only for a session that has joined the incident and costs 5ms to get out of the way of every other session (starting node costs 47ms whatever the hook then decides); `noscope-session-start.mjs` alone is ungated, because its job is telling a session that does not know about an incident that one exists. Every seat-hook invocation is traced to the run folder's `hooks/seat-stop.log`: `noscope-seat-stop.mjs` applies each agent seat's returned object to the record on `SubagentStop` and pushes a rejected one back with the reasons (a session that owns a slice records its own turns); `noscope-guard-brief.mjs` refuses a brief to a seat that the validator rejects; `noscope-guard-record.mjs` refuses hand edits of `incident.json`, `log.jsonl` and `run.json`; `noscope-after-tool.mjs` tells the directing session what the hooks applied and what is next; `noscope-loop.mjs` keeps it cycling while the incident has work; `noscope-log-turn.mjs` logs every session's turn as a call from its transcript; `noscope-context-monitor.sh` forces a handoff before compaction; `noscope-session-start.mjs` announces an open incident. `lib.mjs` is shared. |
| `statusline/noscope-statusline.sh` | A status line that is also the compaction guard's sensor: it writes the context percentage to `~/.claude/.handoff-state/<session>.pct`. `/noscope-install` registers it or adds its sensor block to an existing status line. |
| `tests/scenario.sh` | The whole loop against a scratch repository, driven through the hooks as a live session would drive it; exits non-zero at the first step that misbehaves. |
| `.claude-plugin/` | `plugin.json` and `marketplace.json`. |
