#!/usr/bin/env bash
# A minimal status line that is also the sensor the compaction guard needs: on every render it
# writes the context percentage Claude Code passes on stdin to ~/.claude/.handoff-state/<session>.pct.
# /noscope-install registers it when no status line is configured; when one is, it adds the sensor
# block (the four lines under "Sensor") to the existing script instead.
input=$(cat)
command -v jq >/dev/null 2>&1 || { echo ""; exit 0; }
session=$(printf '%s' "$input" | jq -r '.session_id // empty')
model=$(printf '%s' "$input" | jq -r '.model.display_name // .model.id // empty')
dir=$(printf '%s' "$input" | jq -r '.workspace.current_dir // .cwd // empty')
pct=$(printf '%s' "$input" | jq -r '.context_window.used_percentage // empty')
context=""
if [ -n "$pct" ]; then
  pct_int="${pct%.*}"
  context=" | Context: ${pct_int}% used"
  # Sensor: the compaction guard reads this file.
  if [ -n "$session" ]; then
    sdir="$HOME/.claude/.handoff-state"
    mkdir -p "$sdir" 2>/dev/null && printf '%s' "$pct_int" > "$sdir/${session}.pct" 2>/dev/null
  fi
fi
noscope=""
here=$(cd "$(dirname "$0")" && pwd)
# The sensor above is pure bash and needs nothing but $HOME, which is what lets this file be
# copied to a stable path: /noscope-install installs it at ~/.claude/noscope/statusline.sh so
# the status line does not point into the plugin's versioned cache directory, which changes on
# every `claude plugin update` and would leave the compaction guard silently dead.
# The incident segment below does need the plugin, so it looks for it beside this file first
# and then in the cache, and simply shows nothing if it cannot find it.
scripts="$here/../scripts"
if [ ! -f "$scripts/incident_current.mjs" ]; then
  scripts=$(ls -d "$HOME"/.claude/plugins/cache/*/noscope/*/scripts 2>/dev/null | sort -V | tail -1)
fi
if [ -n "${scripts:-}" ] && [ -f "$scripts/incident_current.mjs" ] && current=$(node "$scripts/incident_current.mjs" "$dir" 2>/dev/null); then
  noscope=" | noscope $(printf '%s' "$current" | jq -r '"\(.id) \(.status) p\(.period)"')"
fi
printf '%s | %s%s%s\n' "${dir/#$HOME/~}" "$model" "$context" "$noscope"
