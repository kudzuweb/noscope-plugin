#!/usr/bin/env bash
# Open a new terminal tab running a Claude Code session that is a seat of an incident: the IC
# taking command (after a handoff), or a unit's leader.
#
#   launch-session.sh start  <working-directory> <model-id> <session-name> <prompt-file>   a new IC, before any incident exists
#   launch-session.sh ic     <run-folder> <model-id> <session-name>                         a successor IC, after a handoff
#   launch-session.sh leader <run-folder> <model-id> <session-name> <unit-id>
#   launch-session.sh refusal_fallback <run-folder> <model-id> <session-name> <task-id>   a refused subagent, rerun as a session on its tier's previous model
#
# `start` is how a run is kicked off from another session (/noscope-start): the prompt file holds
# the /noscope-run invocation, objective and answers included, so the new IC asks nothing.
# How the tab is opened, in order: $NOSCOPE_HOME/open-tab.sh when /noscope-install wrote an adapter for
# this machine's terminal, else Warp on macOS via a tab config and `open warp://tab_config/...`,
# else nothing, and it exits 2 saying what to run by hand. The tab runs claude with NOSCOPE_ROLE,
# NOSCOPE_RUN and (for a leader) NOSCOPE_UNIT in its
# environment, which the plugin's hooks read to know which seat they run under; `--name` makes
# the session addressable by SendMessage from any other session on the machine; the permission
# mode is the IC's, read from <run-folder>/hooks/ic.json, so cross-session messages are not
# held for approval. The first prompt orients the seat and names the skill it runs.
#
# Exit 0 means the session confirmed itself up. Exit 1 means the tab opened but no session ever
# reported in, after the retries. Exit 2 means no tab could be opened at all. In every non-zero
# case the command to run by hand is printed, and the caller hands it to the human.
set -euo pipefail
role="${1:?start|ic|leader|refusal_fallback}"; folder="${2:?run folder or working directory}"; model="${3:?model id}"; name="${4:?session name}"; unit="${5:-}"
case "$name" in *[!A-Za-z0-9._-]*) echo "launch-session.sh: name must be letters, digits, dot, underscore or dash" >&2; exit 1;; esac
if [ "$role" = start ]; then
  cwd="$folder"; [ -d "$cwd" ] || { echo "launch-session.sh: no such directory $cwd" >&2; exit 1; }
  [ -f "$unit" ] || { echo "launch-session.sh: start needs a prompt file as the fifth argument" >&2; exit 1; }
  id=""; mode=""
else
  [ -f "$folder/incident.json" ] || { echo "launch-session.sh: no incident.json in $folder" >&2; exit 1; }
  id=$(jq -r '.incident.id' "$folder/incident.json")
  cwd=$(jq -r '.incident.workingDirectory' "$folder/incident.json")
  mode=$(jq -r '.permissionMode // empty' "$folder/hooks/ic.json" 2>/dev/null || true)
fi
case "$role" in
  start) prompt="\$(cat '$unit')"; env="NOSCOPE_ROLE=ic NOSCOPE_START=1" ;;   # the prompt spans lines; the tab reads it from the file
  ic) prompt="You are the Incident Commander taking command of noscope incident $id, run under the noscope plugin. Run /noscope-resume $folder and follow it from its first step."; env="NOSCOPE_ROLE=ic NOSCOPE_RUN='$folder'" ;;
  leader) [ -n "$unit" ] || { echo "launch-session.sh: a leader needs a unit id" >&2; exit 1; }
          prompt="You are the leader of unit $unit of noscope incident $id, run under the noscope plugin. Run /noscope-lead $folder $unit and follow it from its first step."; env="NOSCOPE_ROLE=leader NOSCOPE_RUN='$folder' NOSCOPE_UNIT='$unit'" ;;
  refusal_fallback) [ -n "$unit" ] || { echo "launch-session.sh: refusal_fallback needs a task id" >&2; exit 1; }
          # A subagent that refused, run again as a session. The Agent tool's model takes an
          # alias and cannot name a generation, so a seat that needs its tier's previous model
          # cannot be respawned as a subagent at all; a session can, because claude --model
          # takes a full id. The session does the task's own brief and records its own ending,
          # the way a leader records a turn, because a session never raises SubagentStop.
          prompt="You are running task $unit of noscope incident $id as a session, because the subagent for it refused and its tier's previous model cannot be named through the Agent tool. Run node \${CLAUDE_PLUGIN_ROOT}/scripts/incident_orient.mjs task and read what it prints, then the task brief at $folder/brief-$unit.json, which holds your objective, inputs, expected output, completion criteria, scope and the evidence named for you. Do that one task with the tools you have. Then write the resource's result object to $folder/$unit.json with \"taskId\": \"$unit\" at the top level, check it with node \${CLAUDE_PLUGIN_ROOT}/scripts/incident_validator.mjs result $folder/incident.json $folder/$unit.json $unit, fix every REJECT, and record it yourself with node \${CLAUDE_PLUGIN_ROOT}/scripts/incident_apply.mjs ending $folder/incident.json $folder/$unit.json $unit. Then tell the session named in run.json's icSession that $unit ended, in one line, and stop. If you refuse this work too, say so in one line to that session and record nothing."; env="NOSCOPE_ROLE=task NOSCOPE_RUN='$folder' NOSCOPE_TASK='$unit'" ;;
  *) echo "launch-session.sh: role is start, ic, leader or refusal_fallback" >&2; exit 1 ;;
esac
# The launched session's SessionStart hook writes this file, which is the only proof the tab
# ran claude rather than dying in the shell. NOSCOPE_SEAT is what names it.
env="$env NOSCOPE_SEAT='$name'"
up=$(node -e 'import("'"$(cd "$(dirname "$0")" && pwd)"'/incident_lib.mjs").then(m=>process.stdout.write(require("node:path").join(m.NOSCOPE_HOME,"up",process.argv[1].replace(/[^A-Za-z0-9._-]/g,"_")+".json")))' "$name")
# Where a tab that fails to boot leaves its reason. Claude Code writes a boot failure to both
# streams and exits non-zero (verified 2026-09-22 against an unknown model id), so stderr is
# enough to tell an overloaded provider from a bad model id from an authentication failure —
# and an empty file from a tab where claude never ran at all.
errlog="${up%.json}.err"
# A fresh session in the tab stops at the folder-trust dialog until a human clicks it. The
# plugin pre-accepts that only when the human turned preAccept on at install; otherwise the
# tab waits, which is correct and is said out loud so an unattended run is not a mystery.
trust=$(node "$(cd "$(dirname "$0")" && pwd)/incident_trust.mjs" grant "$cwd" "$folder" 2>/dev/null || true)
case "$trust" in *"preAccept is off"*) echo "note: $name will wait on its trust dialog until you click it (preAccept is off; /noscope-install can turn it on)" >&2 ;; esac
# The model id is quoted: a [1m] suffix is a glob to zsh and the tab dies before claude runs.
# Single-quote the prompt safely: an apostrophe in it closes a naive '$prompt' early and the tab
# sits at a shell continuation prompt instead of running claude (seen 2026-09-21 in the keeper launcher).
shq() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
# stderr is copied to a file as well as the terminal, so a tab that never comes up has left its
# reason where the launcher can read it. stdout is untouched: that is the session's own screen.
tap="2> >(tee -a '$errlog' >&2)"
if [ "$role" = start ]; then cmd="$env claude --model '$model' --name $name --remote-control $name \"$prompt\" $tap"
else cmd="$env claude --model '$model' --name $name --remote-control $name${mode:+ --permission-mode $mode} $(shq "$prompt") $tap"; fi
color=$([ "$role" = leader ] && echo blue || echo red)
# Opening a tab is the one thing this plugin cannot do portably, so it is the one thing it lets
# the machine override. /noscope-install writes an adapter for whatever terminal is here; Warp on a
# Mac is the built-in fallback; and with neither, the launcher prints the command for a human to
# run and says so, which every caller already handles. The adapter is given the working
# directory, the command, the session name and a colour, and need only open a tab; confirming
# that the session actually came up is the retry loop's job below, whoever opened it.
adapter="$(node -e 'import("'"$(cd "$(dirname "$0")" && pwd)"'/incident_lib.mjs").then(m=>process.stdout.write(require("node:path").join(m.NOSCOPE_HOME,"open-tab.sh")))')"
file=""
if [ -x "$adapter" ]; then
  opener="adapter"
elif [ "$(uname)" = Darwin ] && [ "${TERM_PROGRAM:-}" = WarpTerminal ] && [ -d "$HOME/.warp" ]; then
  opener="warp"
  dir="$HOME/.warp/tab_configs"; mkdir -p "$dir"
  file="$dir/$name.toml"
  toml() { printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'; }
  cat > "$file" <<TOML
name = "$(toml "$name")"
title = "$(toml "$name")"
color = "$color"

[[panes]]
id = "root"
type = "terminal"
directory = "$(toml "$cwd")"
commands = ["$(toml "$cmd")"]
is_focused = true
TOML
else
  echo "No terminal this plugin can drive (no $adapter, and Warp on macOS not found)." >&2
  echo "Run this in a new terminal yourself:" >&2
  echo "  cd \"$cwd\" && $cmd" >&2
  echo "Run /noscope-install to have an adapter written for your terminal, if it can be scripted." >&2
  exit 2
fi
open_tab() {
  case "$opener" in
    adapter) "$adapter" "$cwd" "$cmd" "$name" "$color" ;;
    warp)    open "warp://tab_config/$name" ;;
  esac
}
# A tab that never runs claude is silent: the shell eats the command, a dialog blocks it, or
# the boot fails, and the seat that launched it waits forever for a check-in. So the launch is
# confirmed rather than assumed: clear the marker, open the tab, and wait for the session's
# SessionStart hook to write it. Measured 2026-09-22 on the machine this was written on: one tab reaches the hook
# in about 3 seconds, three launched together in about 7.5, so the default wait is generous.
# NOSCOPE_LAUNCH_TIMEOUT and NOSCOPE_LAUNCH_TRIES exist for tests; leave them unset in a run.
# NOSCOPE_LAUNCH_NO_OPEN makes the launcher skip `open`, which is how the scenario drives it.
timeout=${NOSCOPE_LAUNCH_TIMEOUT:-30}; tries=${NOSCOPE_LAUNCH_TRIES:-3}
rm -f "$up" "$errlog"
attempt=1
while :; do
  [ -n "${NOSCOPE_LAUNCH_NO_OPEN:-}" ] || open_tab
  waited=0
  while [ "$waited" -lt "$timeout" ]; do
    if [ -f "$up" ]; then
      echo "launched: $name via the $opener${file:+ ($file)}"
      echo "up: $name reached its session in ${waited}s${attempt:+ (attempt $attempt)}"
      exit 0
    fi
    sleep 1; waited=$((waited + 1))
  done
  # One last look before opening again, so a tab that was merely slow does not get a twin.
  if [ -f "$up" ]; then echo "launched: $name via the $opener${file:+ ($file)}"; echo "up: $name reached its session late (attempt $attempt)"; exit 0; fi
  [ "$attempt" -lt "$tries" ] || break
  echo "launch-session.sh: $name did not come up within ${timeout}s; opening it again (attempt $((attempt + 1)) of $tries)" >&2
  attempt=$((attempt + 1))
done
# Two retries and then it is the calling seat's decision, not the launcher's. The launcher knows
# a tab did not come up; it does not know whether this seat matters enough to wait for a human,
# whether the work can be reassigned, or whether the incident should go on without it. So it
# reports what it tried and hands the choice back, rather than leaving a seat to infer one.
echo "launch-session.sh: $name never came up after $tries attempts of ${timeout}s each, opened with the $opener${file:+ (tab config $file)}." >&2
echo "launch-session.sh: role=$role${unit:+ unit=$unit} model=$model" >&2
if [ -s "$errlog" ]; then
  echo "launch-session.sh: what the tab reported before it stopped ($errlog):" >&2
  tail -n 6 "$errlog" | sed 's/^/    /' >&2
  echo "launch-session.sh: decide on that reason. An overloaded or rate-limited provider is worth" >&2
  echo "  waiting out and launching again; a model the catalogue does not carry is a wrong id in" >&2
  echo "  the plan or the config and you can correct it; an authentication failure is the human's," >&2
  echo "  so raise it as a question rather than retrying." >&2
else
  echo "launch-session.sh: the tab reported nothing, so claude never ran in it: the shell ate the" >&2
  echo "  command, the tab never opened, or it is waiting on a dialog (preAccept is off)." >&2
fi
echo "launch-session.sh: the command, if a human runs it in a terminal:" >&2
echo "  cd \"$cwd\" && $cmd" >&2
echo "launch-session.sh: this is yours to decide. In an attended run, give the human that command" >&2
echo "  and carry on without the seat until it checks in. In an unattended run, do not wait on a" >&2
echo "  check-in that will not arrive: a leader that cannot be launched leaves its unit unled, so" >&2
echo "  close the unit or reassign its slice at your next turn and say which you did and why." >&2
exit 1
