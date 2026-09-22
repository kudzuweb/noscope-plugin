#!/usr/bin/env bash
# The compaction guard for an incident, on Stop and PreCompact. No hook event receives context
# usage on stdin, so the status line is the sensor: statusline/noscope-statusline.sh (or any status
# line that does the same) writes the window percentage to ~/.claude/.handoff-state/<session>.pct
# on every render, and this hook reads it. When the percentage crosses the threshold inside an
# open incident, the stop is blocked once with the instruction to run /noscope-handoff. Outside an
# incident it does nothing, so a global guard can own that case and yield inside one.
#
# Threshold: handoffThreshold in ~/.claude/noscope/config.json (default 75); CLAUDE_HANDOFF_THRESHOLD overrides.

STATE_DIR="$HOME/.claude/.handoff-state"
CONFIG="$HOME/.claude/noscope/config.json"
input=$(cat)
command -v jq >/dev/null 2>&1 || exit 0
command -v node >/dev/null 2>&1 || exit 0

event=$(printf '%s' "$input" | jq -r '.hook_event_name // empty')
session=$(printf '%s' "$input" | jq -r '.session_id // "default"')
cwd=$(printf '%s' "$input" | jq -r '.cwd // empty')
[ -n "$(printf '%s' "$input" | jq -r '.agent_id // empty')" ] && exit 0   # a seat's own stop, not the IC's
[ -n "${NOSCOPE_ROLE:-}" ] && [ "$NOSCOPE_ROLE" != "ic" ] && exit 0                     # a leader session hands off nothing

# The open incident, if any.
here=$(cd "$(dirname "$0")" && pwd)
current=$(node "$here/../scripts/incident_current.mjs" "$cwd" 2>/dev/null) || exit 0
folder=$(printf '%s' "$current" | jq -r '.folder')
case "$(printf '%s' "$current" | jq -r '.status')" in satisfied|failed|stopped) exit 0;; esac

threshold="${CLAUDE_HANDOFF_THRESHOLD:-$(jq -r '.handoffThreshold // 75' "$CONFIG" 2>/dev/null || echo 75)}"
[ -n "$threshold" ] || threshold=75
pct_file="$STATE_DIR/${session}.pct"
[ -f "$pct_file" ] || exit 0
pct=$(cat "$pct_file" 2>/dev/null)
[ -n "$pct" ] && [ "$pct" -ge 0 ] 2>/dev/null || exit 0

reason="[noscope] Context is at ${pct}% of the window, past the ${threshold}% threshold, and incident $(printf '%s' "$current" | jq -r '.id') is open at $folder. Before anything else, run /noscope-handoff: it writes and validates the HandoffDocument, records the transfer, moves the heartbeat, launches the successor session with /noscope-resume, and then this session stops. Do not compact and carry on: the record is complete, so the successor loses nothing."
warn="[noscope] Context at ${pct}% inside an open incident: handing command to a fresh session."

case "$event" in
  PreCompact)
    if [ "$pct" -ge "$threshold" ]; then
      jq -n --arg msg "$warn" --arg ctx "$reason" '{ systemMessage: $msg, hookSpecificOutput: { hookEventName: "PreCompact", additionalContext: $ctx } }'
    fi
    exit 0 ;;
  Stop|*)
    [ "$(printf '%s' "$input" | jq -r '.stop_hook_active // false')" = "true" ] && exit 0
    mkdir -p "$STATE_DIR" 2>/dev/null
    state_file="$STATE_DIR/${session}.noscope-state"
    prev=$(cat "$state_file" 2>/dev/null)
    if [ "$pct" -ge "$threshold" ]; then
      if [ "$prev" != "fired" ]; then
        printf 'fired' > "$state_file" 2>/dev/null
        jq -n --arg msg "$warn" --arg reason "$reason" '{ decision: "block", reason: $reason, systemMessage: $msg }'
      fi
    else
      [ "$prev" != "armed" ] && printf 'armed' > "$state_file" 2>/dev/null
    fi
    exit 0 ;;
esac
