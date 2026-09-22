#!/usr/bin/env bash
# Runs a node hook only for a session that is a seat of an incident, and gets out of the way for
# every other session on the machine. Every entry in hooks.json calls this instead of node
# directly, except SessionStart, whose job is telling a session that does not know about an
# incident that one exists.
#
#   bash noscope-gate.sh <hook-script>            the hook's stdin is passed through unchanged
#
# The hook is a .mjs run under node or a .sh run under bash. noscope-context-monitor.sh is bash
# but starts node itself to find the open incident, so it costs what a node hook costs and is
# gated with them.
#
# Starting node costs 47ms whatever the hook then decides. So the decision is made here, in two
# tiers, cheapest first (measured on this machine 2026-09-22, twenty runs each, against
# noscope-log-turn.mjs: 47.0ms ungated, and gated 2.8ms at the first tier and 8ms at the second
# once hooks.json moved to exec form and no shell stands in front of this script):
#
#   1. No session anywhere has joined an incident -> exit. Costs one glob and no fork, and it is
#      the case for every session on a machine with no incident running.
#   2. This session has not joined -> exit. Costs reading stdin and one jq against it.
#
# Where membership cannot be established either way the hook runs: no jq, no session_id in the
# input, or an unreadable marker directory all mean the gate cannot prove this session is
# unrelated, and a hook that runs when it need not is slow where one that is skipped is wrong.
#
# SESSIONS is scripts/incident_lib.mjs's SESSIONS_DIR, hardcoded because resolving it through
# node would cost the 47ms this script exists to avoid. That file owns the path; this is the one
# copy of it, and tests/scenario.sh asserts the two still agree.
set -u
SESSIONS="$HOME/.claude/noscope/sessions"
hook="${1:-}"
[ -n "$hook" ] || { echo "noscope-gate.sh needs the hook script to run" >&2; exit 1; }

[ -d "$SESSIONS" ] || exit 0
shopt -s nullglob
markers=("$SESSIONS"/*)
(( ${#markers[@]} )) || exit 0

input=$(cat)
sid=$(jq -r '.session_id // empty' <<<"$input" 2>/dev/null) || sid=""
sid="${sid//[^A-Za-z0-9._-]/_}"   # the same name incident_lib.mjs's sessionMarkerPath writes
if [ -n "$sid" ] && [ ! -e "$SESSIONS/$sid" ]; then exit 0; fi

case "$hook" in
  *.sh) exec bash "${BASH_SOURCE[0]%/*}/$hook" <<<"$input" ;;
  *)    exec node "${BASH_SOURCE[0]%/*}/$hook" <<<"$input" ;;
esac
