#!/usr/bin/env bash
# Runs the whole loop against a scratch repository, driving the record through the hooks the
# way a live session would: every seat's object arrives as a SubagentStop message, every brief
# goes through the brief guard, and the loop hook is asked at the points a session would stop.
# Exits non-zero on the first step that does not behave. Usage: tests/scenario.sh [scratch-dir]
# The incidents repository is created under the scratch dir, never under the configured one; the
# pointer in ~/.claude/noscope/current.json for the scratch repo is removed at the end.
set -u
P=$(cd "$(dirname "$0")/.." && pwd); S=$P/scripts; H=$P/hooks
T=${1:-$(mktemp -d)}; rm -rf "$T"; mkdir -p "$T/repo/src"; echo 'el.focus()' > "$T/repo/src/a.js"; echo 'noop' > "$T/repo/src/b.js"
CWD=$T/repo
# The scenario joins the incident under an id of its own, so it never marks the session running
# the test a seat of a scratch run. Everything below inherits it through the environment.
export NOSCOPE_SESSION_ID="scenario-$$"
SESSIONS="$HOME/.claude/noscope/sessions"
# A run that stops at a failing step must not leave its marker on the machine: the directory
# would never be empty again, and the gate's cheap tier is the one that needs it empty.
trap 'rm -f "$SESSIONS/$NOSCOPE_SESSION_ID"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
hook_in() { node -e 'const fs=require("fs");const [f,cwd,json]=process.argv.slice(1);fs.writeFileSync(f,JSON.stringify({cwd,...JSON.parse(json)}))' "$T/in.json" "$CWD" "$1"; }
seat_stop() { # <agent_type> <agent_id> <object-json>
  hook_in "$(node -e 'const [t,i,o]=process.argv.slice(1);console.log(JSON.stringify({hook_event_name:"SubagentStop",agent_type:t,agent_id:i,last_assistant_message:"Done.\n\n```json\n"+o+"\n```"}))' "$1" "$2" "$3")"
  node "$H/noscope-seat-stop.mjs" < "$T/in.json"
}
seat_stop_raw() { # <agent_type> <agent_id> <session_id> <last message, verbatim>
  hook_in "$(node -e 'const [t,i,s,m]=process.argv.slice(1);console.log(JSON.stringify({hook_event_name:"SubagentStop",agent_type:t,agent_id:i,session_id:s,last_assistant_message:m}))' "$1" "$2" "$3" "$4")"
  node "$H/noscope-seat-stop.mjs" < "$T/in.json"
}
inflight_of() { node -e 'const f=process.argv[1];const fs=require("fs");process.stdout.write(String(fs.existsSync(f)?(JSON.parse(fs.readFileSync(f,"utf8")).n??0):0))' "$F/hooks/inflight-$1.json"; }
expect_block() { grep -q '"decision":"block"' <<<"$1" || fail "$2: expected a block, got: $1"; }
expect_silent() { [ -z "$1" ] || fail "$2: expected silence, got: $1"; }
step() { echo "== $*"; }

step "init"
F=$(node "$S/incident_init.mjs" "$CWD" --objective "Determine why the page scrolls to the bottom after a comment is deleted" --priority "observation over reading" --mode until_done --attended yes --incidents-dir "$T/incidents" --planner-model smallest --leader-model smallest) || fail init
[ -d "$T/incidents/.git" ] || fail "incidents repo not initialized"
[ -z "$(ls -A "$CWD" | grep -v src)" ] || fail "the working repo got files: $(ls -A "$CWD")"
[ -f "$F/incident.json" ] || fail "no state"

step "loop hook blocks the stop while the IC has work"
out=$(hook_in '{"hook_event_name":"Stop"}'; node "$H/noscope-loop.mjs" < "$T/in.json"); expect_block "$out" loop-1

step "size-up through the seat hook"
B='{"kind":"diagnosis","dominantProblem":"A focus() call scrolls the page after a delete.","obviouslyNeeded":[{"what":"the app source","checked":true,"finding":"ls showed src/"},{"what":"a running app to reproduce on","checked":false}],"initialObjectives":["Establish by observation which container scrolls"],"initialOrganization":["an observation unit on Sonnet"],"questionsForHuman":["Which environment did the report come from?"],"hazards":["the objective may name the wrong element"],"incomingCommander":{"provider":"claude-code","model":"claude-opus-5","why":"weighing evidence to a cause"},"seatModels":{"planner":{"model":"claude-sonnet-5","why":"a two-unit diagnosis with an obvious decomposition"},"leader":{"model":"claude-haiku-4-5","why":"narrow, well-marked tasks"}}}'
out=$(seat_stop noscope:sizeup a1 "$B"); expect_silent "$out" sizeup
node -e 'const s=require(process.argv[1]);if(s.situation.open.length!==1||s.briefing.questions.length!==1)process.exit(1)' "$F/incident.json" || fail "briefing not seeded"
node -e 'const r=require(process.argv[1]);if(r.models.planner!=="claude-sonnet-5"||r.models.leader!=="claude-haiku-4-5"||r.models.ic!=="claude-sonnet-5")process.exit(1)' "$F/run.json" || fail "smallest seats not routed from the size-up (got $(cat "$F/run.json" | tr -d '\n ' | grep -o '"models":{[^}]*}'))"
node "$S/incident_brief.mjs" planner "$F/incident.json" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d);if(o.seatModel!=="claude-sonnet-5"||o.models.leader!=="claude-haiku-4-5")process.exit(1)})' || fail "planner brief does not carry the routed models"

step "first command turn with a grep under command"
cat > "$F/turn-1.json" <<JSON
{"briefingEvaluation":[{"item":"Establish by observation which container scrolls","verdict":"accepted","why":"the objective's first step"}],
 "briefingQuestions":[{"proposal":1,"verdict":"discard","why":"the objective names the local app; no other environment is in scope"}],
 "periodObjectives":["Establish by observation which container scrolls when a comment is deleted"],"priorities":["observation over reading"],"reportVerdicts":[],
 "situation":{"picture":"A focus() call scrolls the page after a delete; nothing observed yet.","evidence":[],"open":[{"what":"a running app to reproduce on","settledBy":"a reproduce task on the local app"}],"assessment":{"kind":"on_track","why":"first turn"},"changed":"Took the briefing's seed."},
 "closeUnits":[],"assignTasks":[{"unit":"001-command","resource":"grep","objective":"Every focus( call","inputs":{"root":"src","pattern":"focus\\\\("},"expectedOutput":"matches","completionCriteria":["all listed"],"evidenceRequired":[],"dependsOn":[],"instructions":"grep","provider":null,"model":null,"budget":{}}],
 "questionsForHuman":[],"resourceGaps":[],"grantRequests":[],"incidentStatus":"continue","rationale":"Reproduce first."}
JSON
node "$S/incident_validator.mjs" command "$F/incident.json" "$F/turn-1.json" >/dev/null || fail "turn 1 rejected"
node "$S/incident_apply.mjs" command "$F/incident.json" "$F/turn-1.json" >/dev/null || fail "turn 1 apply"

step "deterministic task under command"
node "$S/incident_apply.mjs" start "$F/incident.json" 001-t01 >/dev/null
node "$S/incident_evidence.mjs" grep "$CWD/src" 'focus\(' > "$F/001-t01.json" || fail grep
node "$S/incident_apply.mjs" ending "$F/incident.json" "$F/001-t01.json" 001-t01 | grep -q "1 match" || fail "grep ending"

step "planner: a draft that breaks a rule is blocked, then a good one is saved"
BAD='{"createUnits":[{"ref":"obs","parent":"001-command","type":"base","objective":"Establish by observation what moves when a comment is deleted","scope":"the running app and its scroll behaviour: what moves on screen when a comment is deleted","leader":{"provider":"claude-code","model":"claude-sonnet-5"},"resourcesAssigned":["Read"],"bashAllowlist":[]}],"closeUnits":[],"createTasks":[{"ref":"r","unit":"obs","resource":"reproduce","objective":"Delete a middle comment and measure both containers","scope":"the running app in the browser: the deletion interaction and the scroll positions around it","inputs":{"url":"http://localhost:1"},"expectedOutput":"scrollTop before and after","completionCriteria":["both measured"],"evidenceRequired":["numbers"],"dependsOn":[],"evidenceFrom":{"tasks":["001-t01"]},"instructions":"do it","provider":"claude-code","model":"claude-sonnet-5","budget":{"seconds":600}},{"ref":"i","unit":"obs","resource":"investigate","objective":"Classify each focus( call site","scope":"the focus( call sites in src/, read from the grep evidence","inputs":{},"expectedOutput":"the on-delete site","completionCriteria":["each classified"],"evidenceRequired":["file:line"],"dependsOn":[],"evidenceFrom":{"tasks":["001-t01"]},"instructions":"read them","provider":"claude-code","model":"claude-haiku-4-5","budget":{"seconds":300}}],"cancelTasks":[],"questionsForHuman":[],"grantRequests":[],"resourceGaps":[],"applySops":[],"incidentStatus":"continue","rationale":"one unit; the reading runs alongside"}'
out=$(seat_stop noscope:planner p1 "$BAD"); expect_block "$out" planner-bad
grep -q "Open items are worked" <<<"$out" || fail "planner-bad: wrong reason: $out"
GOOD=$(node -e 'const p=JSON.parse(process.argv[1]);p.createTasks[0].settles=["001-o01"];console.log(JSON.stringify(p))' "$BAD")
out=$(seat_stop noscope:planner p1 "$GOOD"); expect_silent "$out" planner-good
[ -f "$F/draft-1.json" ] || fail "draft not saved"
grep -q '"type":"plan.rejected"' "$F/log.jsonl" || fail "the rejected draft was not logged"

step "review: a correct with two patches is applied to the draft deterministically and logged"
cat > "$F/review-1.json" <<'JSON'
{"verdict":"correct","patches":[{"kind":"set","task":"i","field":"model","value":"claude-sonnet-5"},{"kind":"set","task":"#1","field":"instructions","value":"Delete a middle comment twice; measure the page and the rail before and after each."}],"rationale":"the reading needs judgment on which site runs; the reproduction needs two trials"}
JSON
node "$S/incident_validator.mjs" review "$F/incident.json" "$F/review-1.json" "$F/draft-1.json" >/dev/null || fail "review rejected"
node "$S/incident_apply.mjs" review "$F/incident.json" "$F/review-1.json" "$F/draft-1.json" >/dev/null || fail "review apply"
node -e 'const d=require(process.argv[1]);if(d.createTasks[1].model!=="claude-sonnet-5"||!/twice/.test(d.createTasks[0].instructions))process.exit(1)' "$F/draft-1.json" || fail "patches not applied"
node "$S/incident_validator.mjs" plan "$F/incident.json" "$F/draft-1.json" >/dev/null || fail "patched draft rejected"
grep -q '"type":"plan.reviewed"' "$F/log.jsonl" || fail "review not logged"
node "$S/incident_apply.mjs" plan "$F/incident.json" "$F/draft-1.json" >/dev/null || fail "plan apply"

step "a seat is handed the shape it fills, and the shapes match the protocol"
node "$S/build_shapes.mjs" --check >/dev/null || fail "references/protocol-objects.json and the protocol have drifted; run node scripts/build_shapes.mjs"
node "$S/incident_brief.mjs" planner "$F/incident.json" > "$T/shape.json" || fail "no planner brief"
cat > "$T/shape.js" <<'JS'
const fs = require("fs");
const b = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const bad = [];
const r = b.returns;
if (typeof r !== "object" || Array.isArray(r) || r === null) bad.push("returns is not a shape, it is " + typeof r);
else {
  // The shape must be the object's own shape: arrays where the protocol says array, and a
  // scope on a task, which is where three misindented bullets used to put it elsewhere.
  if (!Array.isArray(r.createTasks)) bad.push("createTasks is not an array in the shape");
  const t = (r.createTasks || [])[0] || {};
  if (typeof t.scope !== "string") bad.push("a task in the shape has no scope");
  if (typeof t.objective !== "string") bad.push("a task in the shape has no objective");
  if ("scope" in r) bad.push("scope sits on the plan itself, not on a task");
}
if (bad.length) { console.error(bad.join("; ")); process.exit(1); }
JS
node "$T/shape.js" "$T/shape.json" || fail "the planner is not handed a fillable shape"

step "nothing tells a seat to read a file the plugin has not got"
cat > "$T/paths.js" <<'JS'
const fs = require("fs"), path = require("path");
const root = process.argv[2];
const bad = [];
const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => {
  if (e.name.startsWith(".") || e.name === "archive" || e.name === "node_modules") return [];
  const p = path.join(d, e.name);
  return e.isDirectory() ? walk(p) : (/\.(md|mjs|sh|json)$/.test(e.name) ? [p] : []);
});
for (const f of walk(root)) {
  const text = fs.readFileSync(f, "utf8");
  for (const m of text.matchAll(/\$\{?CLAUDE_PLUGIN_ROOT\}?\/([A-Za-z0-9_./-]+)/g)) {
    const rel = m[1].replace(/[.,;)`'"]+$/, "");
    if (!rel.includes(".")) continue;                       // a folder, not a file
    if (!fs.existsSync(path.join(root, rel))) bad.push(`${path.relative(root, f)} names ${rel}, which does not exist`);
  }
}
if (bad.length) { console.error([...new Set(bad)].join("\n")); process.exit(1); }
JS
node "$T/paths.js" "$P" || fail "a prompt or document names a plugin file that is not there"

step "every seat's orientation assembles from one file, and the record can name which"
for k in ic leader planner sizeup task; do
  node "$S/incident_orient.mjs" $k > "$T/orient-$k.txt" || fail "no orientation assembles for seat kind $k"
  [ -s "$T/orient-$k.txt" ] || fail "the orientation for $k came out empty"
  grep -q "Incident Command System" "$T/orient-$k.txt" || fail "$k is not told what the system is modelled on"
  grep -q "observe, orient, decide, act" "$T/orient-$k.txt" || fail "$k is not told the loop it is part of"
  grep -q "Observations flow up" "$T/orient-$k.txt" || fail "$k is not told which way orientation travels"
done
# Only the seats that spawn others are told how to write a prompt.
grep -q "seat line and nothing else" "$T/orient-ic.txt" || fail "the IC is not told how to prompt a seat it spawns"
grep -q "seat line and nothing else" "$T/orient-leader.txt" || fail "a leader is not told how to prompt a seat it spawns"
grep -q "seat line and nothing else" "$T/orient-task.txt" && fail "a task seat spawns nothing and should not carry prompting rules"
node "$S/incident_orient.mjs" nonesuch >/dev/null 2>&1 && fail "an unknown seat kind was given an orientation"
node "$S/incident_orient.mjs" leader --stamp | grep -q "orientation: references/orientation.json@" || fail "the stamp does not name the file and commit the orientation came from"

step "the seat line is built, and the guard reads back every field it puts in"
node "$S/incident_brief.mjs" task "$F/incident.json" 001-t01 > "$T/sl-brief.json"
LINE=$(node "$S/incident_seatline.mjs" "$F" task "$T/sl-brief.json" 001-t01) || fail "seat line not built"
# Round-trip it through the guard's own parser: the two must agree field for field, which is the
# whole reason the line is built rather than typed.
node --input-type=module -e '
const { briefAndSeatLine } = await import(process.argv[1]);
const { brief, seat } = briefAndSeatLine(process.argv[2]);
const bad = [];
if (!brief) bad.push("the brief file was not found from the line");
for (const k of ["briefFile", "pluginRoot", "runFolder", "taskId"]) if (!seat[k]) bad.push(k + " did not parse");
if (seat.pluginRoot && /[.,;]$/.test(seat.pluginRoot)) bad.push("pluginRoot kept the sentence punctuation: " + seat.pluginRoot);
if (bad.length) { console.error(bad.join("; ")); process.exit(1); }
' "$H/lib.mjs" "$LINE" || fail "the guard cannot read back a seat line this plugin built: $LINE"
# A model is never named without the alias the Agent tool needs for it. A deterministic task has
# no model at all, and then neither field belongs on the line.
case "$LINE" in
  *"Model:"*"Agent tool alias:"*) ;;
  *"Model:"*) fail "a seat line names a model with no Agent tool alias beside it: $LINE";;
esac
node "$S/incident_seatline.mjs" "$F" task "$T/sl-brief.json" >/dev/null 2>&1 && fail "a task seat line was built without a task id"
node "$S/incident_seatline.mjs" "$F" task /nonexistent.json 001-t01 >/dev/null 2>&1 && fail "a seat line was built naming a brief file that does not exist"
# The alias the leader is told to use must be one the Agent tool takes, not one invented here.
node --input-type=module -e '
const m = await import(process.argv[1]);
const allowed = new Set(["fable", "opus", "sonnet", "haiku"]);
for (const [id, alias] of Object.entries(m.MODEL_ALIAS)) {
  if (alias !== null && !allowed.has(alias)) { console.error(`${id} maps to ${alias}, which the Agent tool does not accept`); process.exit(1); }
  if (!m.AVAILABLE_MODELS.includes(id)) { console.error(`${id} has an alias but is not a model this plugin offers`); process.exit(1); }
}
for (const id of m.AVAILABLE_MODELS) if (!(id in m.MODEL_ALIAS)) { console.error(`${id} is offered but has no Agent tool alias`); process.exit(1); }
' "$S/incident_lib.mjs" || fail "the model alias table disagrees with the models this plugin offers"

step "session names are built by one script, so launching and looking up agree"
ic=$(node "$S/incident_name.mjs" "$F" ic); ul=$(node "$S/incident_name.mjs" "$F" leader 001-u01)
case "$ic" in IC-001-*) ;; *) fail "the IC name does not carry its role and incident: $ic";; esac
case "$ul" in UL-001-1-*) ;; *) fail "a leader name does not carry its role, incident and unit: $ul";; esac
# A task's name carries its whole id, because noscope-seat-stop.mjs recovers the task from the
# agent's name with /(\d{3}-t\d+)/ when a seat returns no id of its own.
tn=$(node "$S/incident_name.mjs" "$F" task 001-t01)
node -e 'const n=process.argv[1];const m=/(\d{3}-t\d+)/.exec(n);if(!m||m[1]!=="001-t01")process.exit(1)' "$tn" || fail "the hook cannot recover a task id from the name it is given: $tn"
[ "$(node "$S/incident_name.mjs" "$F" ic)" = "$ic" ] || fail "the same call gave two different names"
[ "$(node "$S/incident_name.mjs" "$F" leader 001-command)" = "$ic" ] || fail "the command unit should name the IC, not a second seat"
[ "$(node "$S/incident_name.mjs" "$F" ic 2)" != "$ic" ] || fail "a successor takes the same name as the session handing over"
case "$ic$ul" in *--*) fail "a name has an empty word in it: $ic $ul";; esac
printf '%s' "$ic$ul" | grep -qE '^[A-Za-z0-9._-]+$' || fail "a name has a character launch-session.sh refuses: $ic $ul"
node "$S/incident_name.mjs" "$F" leader 001-u99 >/dev/null 2>&1 && fail "a name was invented for a unit that does not exist"
# Every word is whole: a budget that cuts mid-word reads as a mistake rather than a label.
node -e 'const [n,o]=process.argv.slice(1);const ws=n.split("-").slice(3);const t=o.toLowerCase().replace(/[^a-z0-9]+/g," ");for(const w of ws)if(!t.split(" ").includes(w))process.exit(1)' \
  "$ul" "$(node -e 'const s=require(process.argv[1]);console.log(s.units.find(u=>u.id==="001-u01").objective)' "$F/incident.json")" \
  || fail "a leader name carries a word chopped out of its objective: $ul"

step "the leader's orientation, as its own session builds it; a task brief to an agent without a seat line refused, with a leaked situation refused"
node "$S/incident_brief.mjs" orientation "$F/incident.json" 001-u01 > "$F/orient-001-u01.json" || fail orientation
node "$S/incident_validator.mjs" brief "$F/incident.json" "$F/orient-001-u01.json" orientation 001-u01 >/dev/null || fail "orientation rejected"
node -e 'const o=require(process.argv[1]);if("situation" in o||"picture" in o)process.exit(1)' "$F/orient-001-u01.json" || fail "orientation carries the IC picture"
mk_agent() { node -e 'const [f,cwd,type,prompt]=process.argv.slice(1);require("fs").writeFileSync(f,JSON.stringify({cwd,tool_name:"Agent",tool_input:{subagent_type:type,prompt}}))' "$T/in.json" "$CWD" "$1" "$2"; }
node "$S/incident_brief.mjs" task "$F/incident.json" 001-t02 > "$F/brief-001-t02.json"
TB=$(cat "$F/brief-001-t02.json")
mk_agent noscope:task-reproduce "$TB"; node "$H/noscope-guard-brief.mjs" < "$T/in.json" 2>/dev/null && fail "guard let a seat-less task brief through"
mk_agent noscope:task-reproduce "$TB
Plugin root: $P. Run folder: $F. Your task: 001-t02."; node "$H/noscope-guard-brief.mjs" < "$T/in.json" || fail "guard refused a good task brief"
node -e 'const b=require(process.argv[1]);if(!b.returns||!/outcome/.test(b.returns))process.exit(1)' "$F/brief-001-t02.json" || fail "task brief carries no returns field list"
mk_agent noscope:task-reproduce "Brief file: $F/brief-001-t02.json. Plugin root: $P. Run folder: $F. Your task: 001-t02. Model: claude-sonnet-5. Return your object as the last thing you say, as one JSON code block."; node "$H/noscope-guard-brief.mjs" < "$T/in.json" || fail "guard refused a brief by file"
mk_agent noscope:task-reproduce "Brief file: $F/no-such-brief.json. Plugin root: $P. Run folder: $F. Your task: 001-t02."; node "$H/noscope-guard-brief.mjs" < "$T/in.json" 2>/dev/null && fail "guard let a missing brief file through"
LEAK=$(node -e 'const b=JSON.parse(process.argv[1]);b.situation={picture:"x"};console.log(JSON.stringify(b))' "$TB")
mk_agent noscope:task-reproduce "$LEAK
Plugin root: $P. Run folder: $F. Your task: 001-t02."; node "$H/noscope-guard-brief.mjs" < "$T/in.json" 2>/dev/null && fail "guard let a leaked situation through"

step "a unit carries the territory it covers, and the IC and the other units are shown it"
node -e 'const s=require(process.argv[1]);const u=s.units.find(x=>x.id==="001-u01");if(typeof u.scope!=="string"||!u.scope.trim())process.exit(1)' "$F/incident.json" || fail "the unit did not keep the scope the plan gave it"
node "$S/incident_brief.mjs" orientation "$F/incident.json" 001-u01 | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d);if(!o.unit.scope)process.exit(1)})' || fail "a leader is not shown its own scope"
# The IC reads the whole state, so a unit's scope reaches it with the unit.
node -e 'const s=require(process.argv[1]);if(!s.units.every(u=>u.id.endsWith("-command")||typeof u.scope==="string"))process.exit(1)' "$F/incident.json" || fail "a unit reached the record without a scope"
# A plan that leaves one out is refused, the same way a task without one is.
node -e 'const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));p.createUnits=[{ref:"x",parent:"001-command",type:"base",objective:"something",leader:{provider:"claude-code",model:"claude-sonnet-5"},resourcesAssigned:[],bashAllowlist:[]}];p.createTasks=[];fs.writeFileSync(process.argv[2],JSON.stringify(p))' "$F/draft-1.json" "$T/noscope-unit.json" 2>/dev/null || true
if [ -f "$T/noscope-unit.json" ]; then
  node "$S/incident_validator.mjs" plan "$F/incident.json" "$T/noscope-unit.json" 2>&1 | grep -q "has no scope" || fail "a plan creating a unit with no scope was accepted"
fi

step "a task brief carries its siblings' scopes and never their objectives"
node "$S/incident_brief.mjs" task "$F/incident.json" 001-t02 > "$T/brief-t02.json"
node -e '
const b = require(process.argv[1]);
if (!b.task.scope) { console.error("the task brief carries no scope of its own"); process.exit(1); }
if (!Array.isArray(b.siblings)) { console.error("no siblings block"); process.exit(1); }
const sib = b.siblings.find(s => s.taskId === "001-t03");
if (!sib) { console.error("the sibling task is not listed: " + JSON.stringify(b.siblings)); process.exit(1); }
if (!sib.scope) { console.error("the sibling is listed without its scope"); process.exit(1); }
// The objective can carry the IC picture, so it must never travel sideways.
if ("objective" in sib) { console.error("a sibling objective leaked into the brief"); process.exit(1); }
const blob = JSON.stringify(b.siblings);
if (/Classify each focus/.test(blob)) { console.error("a sibling objective leaked as text"); process.exit(1); }
' "$T/brief-t02.json" || fail "task brief siblings block is wrong"

step "task briefs through the guard as messages to the leader, then results through the seat hook"

# The recipient is the name incident_name.mjs builds, not a literal: a guard that keyed off a
# name pattern passed this step for months against a made-up "noscope-…" name while real runs
# would have skipped the guard entirely.
LEADER_NAME=$(node "$S/incident_name.mjs" "$F" leader 001-u01)
case "$LEADER_NAME" in noscope-*) fail "the generated leader name still starts with noscope-, so this step cannot detect the coupling it exists to catch";; esac
for t in 001-t02 001-t03; do
  node "$S/incident_brief.mjs" task "$F/incident.json" $t > "$F/brief-$t.json"
  node -e 'const [f,cwd,to,msg]=process.argv.slice(1);require("fs").writeFileSync(f,JSON.stringify({cwd,tool_name:"SendMessage",tool_input:{to,message:msg}}))' "$T/in.json" "$CWD" "$LEADER_NAME" "$(cat "$F/brief-$t.json")
Plugin root: $P. Run folder: $F. Your task: $t."
  node "$H/noscope-guard-brief.mjs" < "$T/in.json" || fail "guard refused task brief $t"
  node "$S/incident_apply.mjs" start "$F/incident.json" $t "agent-$t" >/dev/null
done
node -e 'const [f,cwd,to]=process.argv.slice(1);require("fs").writeFileSync(f,JSON.stringify({cwd,tool_name:"SendMessage",tool_input:{to,message:"Brief file: /nonexistent/brief.json. Plugin root: x. Run folder: y. Your task: 001-t02."}}))' "$T/in.json" "$CWD" "$LEADER_NAME"
node "$H/noscope-guard-brief.mjs" < "$T/in.json" 2>/dev/null && fail "the guard let a message through to $LEADER_NAME naming a brief file that does not exist; it is keying off the recipient's name again"
R2='{"taskId": "001-t02", "outcome": "answered", "claims": [{"subject": "the page container", "predicate": "scrolls to the bottom after a middle comment is deleted", "object": {"before": 0, "after": 5681}, "confidence": 0.97, "evidence": ["measured"], "basis": "observed", "cites": ["001-t01"]}, {"subject": "the comment rail", "predicate": "does not scroll", "object": {"before": 120, "after": 120}, "confidence": 0.95, "evidence": ["measured"], "basis": "observed", "cites": []}, {"subject": "the focus( call in src/a.js", "predicate": "is the one that runs on deletion", "object": {"file": "src/a.js"}, "confidence": 0.65, "basis": "inferred", "cites": []}], "findings": {"summary": "Deleting a middle comment scrolls the page container to the bottom; the rail does not move.", "observations": [{"step": "delete 3 of 6", "observed": "page 0 -> 5681; rail unchanged"}]}, "needed": []}'
out=$(seat_stop noscope:task-reproduce t2 "$R2"); expect_silent "$out" result-t02
node "$S/incident_apply.mjs" ending "$F/incident.json" "$F/hooks/$(ls -t "$F/hooks" | grep '^task-reproduce' | head -1)" 001-t02 2>/dev/null && fail "a second ending of the same task was applied"
out=$(seat_stop noscope-task-reproduce-001-t02 t2 '"just prose, no object"'); expect_silent "$out" "a finished seat resumed by a message is left alone"
node -e 'const s=require(process.argv[1]);if(s.claims.filter(c=>c.provenance.taskId==="001-t02").length!==3)process.exit(1)' "$F/incident.json" || fail "claims duplicated by a second ending"
step "a leader is shown its own unit, and the IC is no longer the courier for it"
node "$S/incident_next.mjs" "$F/incident.json" --unit 001-u01 > "$T/unitview.json" || fail "no unit view"
cat > "$T/uv.js" <<'JS'
const fs = require("fs");
const v = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const ic = JSON.parse(fs.readFileSync(process.argv[3], "utf8"));
const bad = [];
for (const k of ["unitId", "objective", "scope", "reasons", "unheard", "ready", "running", "reportDue"])
  if (!(k in v)) bad.push("the unit view lacks " + k);
if (v.unitId !== "001-u01") bad.push("the unit view is for " + v.unitId);
// A leader sees its own unit only: no other unit, and nothing of the IC's picture.
const text = JSON.stringify(v);
if (/001-u0[^1]/.test(text)) bad.push("the unit view names another unit");
for (const k of ["situation", "picture", "claims", "reports"]) if (k in v) bad.push("the unit view carries the IC's " + k);
// The IC is not called for a task ending the leader handles itself.
for (const c of ic.call || []) for (const r of c.reasons || [])
  if (/^task .* (failed|came back insufficient|completed)/.test(r)) bad.push("the IC is still called for a task ending: " + r);
if (bad.length) { console.error(bad.join("; ")); process.exit(1); }
JS
node "$S/incident_next.mjs" "$F/incident.json" > "$T/icview.json"
node "$T/uv.js" "$T/unitview.json" "$T/icview.json" || fail "the layers are not separated as intended"
node "$S/incident_next.mjs" "$F/incident.json" --unit 001-u99 >/dev/null 2>&1 && fail "a unit view was built for a unit that does not exist"

step "the record keeps a line of a session task, and the body stays in its file"
cat > "$T/lean.js" <<'JS'
const fs = require("fs");
const s = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const bad = [];
const t = s.tasks.find(x => x.id === "001-t02");
const r = (t && t.result) || {};
if (r.findings) bad.push("the record still holds the findings body");
if (typeof r.summary !== "string" || !r.summary.trim()) bad.push("no summary line was kept");
if (!r.body) bad.push("the record does not say where the body is");
if (JSON.stringify(t).length > 4000) bad.push("the stored task is " + JSON.stringify(t).length + " bytes, not a line");
try {
  const body = JSON.parse(fs.readFileSync(r.body, "utf8"));
  if (!body.findings) bad.push("the file the record points at holds no findings");
} catch (e) { bad.push("the body the record points at could not be read"); }
const eq = s.tasks.find(x => x.id === "001-t01");
if (!eq || !eq.result || !eq.result.measure || !eq.result.body) bad.push("an equipment task kept no measure or no pointer to its output");
if (eq && eq.result && eq.result.matches) bad.push("an equipment task still stores its whole output in the record");
try {
  const out = JSON.parse(fs.readFileSync(eq.result.body, "utf8"));
  const body2 = out.output || out;
  if (!body2.matches) bad.push("the file an equipment task points at does not hold its output");
} catch (e) { bad.push("an equipment task's output file could not be read"); }
if (bad.length) { console.error(bad.join("; ")); process.exit(1); }
JS
node "$T/lean.js" "$F/incident.json" || fail "a session task's result is not stored as a line"
# A result with no line is refused: the record would say a task finished and nothing more.
cat > "$T/nosum.json" <<'JSON'
{"taskId":"001-t02","outcome":"answered","findings":{"observations":[]},"claims":[]}
JSON
node "$S/incident_validator.mjs" result "$F/incident.json" "$T/nosum.json" 001-t02 2>&1 | grep -q "no summary" || fail "a result with no summary line was accepted"

for i in 1 2 3; do out=$(seat_stop noscope:task-investigate t3 '{"taskId":"001-t03","outcome":"answered"}'); expect_block "$out" "give-up round $i"; done
out=$(seat_stop noscope:task-investigate t3 '{"taskId":"001-t03","outcome":"answered"}'); expect_silent "$out" "give-up final"
node -e 'const s=require(process.argv[1]);const t=s.tasks.find(t=>t.id==="001-t03");if(t.status!=="failed")process.exit(1)' "$F/incident.json" || fail "t03 not failed after give-up"
grep -q '"type":"result.rejected"' "$F/log.jsonl" || fail "result rejections not logged"
node "$S/incident_next.mjs" "$F/incident.json" | grep -q '"unitId": "001-u01"' || fail "leader not due a call"

step "a seat killed by a transient API error is not pushed back, and frees the session it was in flight for"
node -e 'const fs=require("fs");fs.mkdirSync(process.argv[1],{recursive:true});fs.writeFileSync(process.argv[1]+"/inflight-sess-dead.json",JSON.stringify({n:1,at:new Date().toISOString()}))' "$F/hooks"
out=$(seat_stop_raw noscope-planner-001-dead pdead sess-dead "API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.")
expect_silent "$out" "a dead seat must not be pushed back; nothing reached the record to correct"
[ "$(inflight_of sess-dead)" = "0" ] || fail "a dead seat left the session in flight at $(inflight_of sess-dead); the loop hook would never push it again"
grep -q 'failed; not pushed back' "$F/hooks/seat-stop.log" || fail "the dead seat was not traced as failed"

step "a launched tab is confirmed by its own session, and a tab that never comes up is retried then reported"
UP=$(node -e 'import("'"$S"'/incident_lib.mjs").then(m=>process.stdout.write(require("node:path").join(m.NOSCOPE_HOME,"up","noscope-scenario-leader.json")))')
rm -f "$UP"
# The session that comes up writes the marker from its SessionStart hook, keyed by NOSCOPE_SEAT.
hook_in '{"hook_event_name":"SessionStart","session_id":"sess-leader"}'
NOSCOPE_SEAT=noscope-scenario-leader NOSCOPE_ROLE=leader NOSCOPE_UNIT=001-u01 node "$H/noscope-session-start.mjs" < "$T/in.json" > /dev/null
[ -f "$UP" ] || fail "the session-start hook did not mark the seat up at $UP"
node -e 'const j=require(process.argv[1]);if(j.sessionId!=="sess-leader")process.exit(1)' "$UP" || fail "the up marker does not name the session"
# A stale marker is cleared before the tab opens, so the session must mark itself up while the
# launcher polls, which is what a real tab does a few seconds in.
rm -f "$UP"
( sleep 1; hook_in '{"hook_event_name":"SessionStart","session_id":"sess-leader"}'; NOSCOPE_SEAT=noscope-scenario-leader NOSCOPE_ROLE=leader NOSCOPE_UNIT=001-u01 node "$H/noscope-session-start.mjs" < "$T/in.json" > /dev/null ) &
out=$(NOSCOPE_LAUNCH_NO_OPEN=1 NOSCOPE_LAUNCH_TIMEOUT=6 NOSCOPE_LAUNCH_TRIES=2 bash "$S/launch-session.sh" leader "$F" claude-sonnet-5 noscope-scenario-leader 001-u01 2>&1) || fail "the launcher failed although the seat came up: $out"
wait
grep -q "^up: noscope-scenario-leader reached its session" <<<"$out" || fail "the launcher did not confirm the seat was up: $out"
# With no marker, it retries the configured number of times and then reports how to do it by hand.
rm -f "$UP"
out=$(NOSCOPE_LAUNCH_NO_OPEN=1 NOSCOPE_LAUNCH_TIMEOUT=1 NOSCOPE_LAUNCH_TRIES=2 bash "$S/launch-session.sh" leader "$F" claude-sonnet-5 noscope-scenario-leader 001-u01 2>&1) && fail "the launcher reported success for a tab that never came up"
# It retries, then hands the decision back rather than deciding for the seat.
case "$out" in *"attempt 2 of 2"*) ;; *) fail "the launcher did not retry before giving up: $out";; esac
case "$out" in *"yours to decide"*) ;; *) fail "the launcher did not hand the decision back to the seat: $out";; esac
case "$out" in *"role=leader unit=001-u01"*) ;; *) fail "the launcher did not say which seat failed: $out";; esac
case "$out" in *"cd \""*) ;; *) fail "the launcher did not print the command a human could run: $out";; esac
# A tab that boots and fails leaves its reason in a log beside the up marker; one that never ran
# claude leaves none, and the launcher says which of the two happened. Only the second can be
# produced here, because NO_OPEN means nothing is ever started.
case "$out" in *"reported nothing, so claude never ran"*) ;; *) fail "the launcher did not distinguish a tab that never ran claude: $out";; esac
grep -q "tee -a" "$S/launch-session.sh" || fail "the launched tab's stderr is no longer copied to a log, so a boot failure leaves no reason"
grep -q 'errlog="\${up%.json}.err"' "$S/launch-session.sh" || fail "the reason log is no longer beside the up marker"
grep -q "opening it again (attempt 2 of 2)" <<<"$out" || fail "the launcher did not retry: $out"
grep -q "never came up after 2 attempts" <<<"$out" || fail "the launcher did not report the failure: $out"
grep -q "the command, if a human runs it in a terminal" <<<"$out" || fail "the launcher did not print the manual command: $out"
rm -f "$UP"

step "the leader's turn prompt through the brief guard, then its report recorded by the leader itself"
node "$S/incident_brief.mjs" turn "$F/incident.json" 001-u01 > "$F/turn-001-u01-1.json"
node -e 'const [f,cwd,to,msg]=process.argv.slice(1);require("fs").writeFileSync(f,JSON.stringify({cwd,tool_name:"SendMessage",tool_input:{to,message:msg}}))' "$T/in.json" "$CWD" noscope-001-001-u01 "Brief file: $F/turn-001-u01-1.json. Plugin root: $P. Run folder: $F. Your unit: 001-u01."
node "$H/noscope-guard-brief.mjs" < "$T/in.json" || fail "guard refused the turn prompt by file"
node -e 'const b=require(process.argv[1]);const r=b.returns;if(!r||typeof r!=="object"||!("kind" in r))process.exit(1)' "$F/turn-001-u01-1.json" || fail "turn brief carries no LeaderTurn shape"
L='{"unitId":"001-u01","kind":"report","report":{"outcome":"met","changed":[{"what":"The page container, not the rail, scrolls after a deletion","claims":["001-c01","001-c02"]}],"pictureChanged":false,"situation":{"picture":"The page container scrolls after a delete; the rail does not.","evidence":[{"claimId":"001-c01","stance":"for"},{"claimId":"001-c02","stance":"for"},{"claimId":"001-c03","stance":"for"}],"open":[{"what":"which focus() site runs on deletion","settledBy":"reading the source"}],"changed":"two reproductions agreed"},"resourceRequests":[{"kind":"human_knowledge","what":"Which browser did the reporter use?","why":"the rail behaves differently in Safari"}]},"assignTasks":[],"consult":[]}'
printf '%s' "$L" > "$F/leader-001-u01-1.json"
node "$S/incident_validator.mjs" leader "$F/incident.json" "$F/leader-001-u01-1.json" 001-u01 >/dev/null || fail "leader turn rejected"
node "$S/incident_apply.mjs" report "$F/incident.json" "$F/leader-001-u01-1.json" 001-u01 >/dev/null || fail "report apply"
node "$S/incident_apply.mjs" heard "$F/incident.json" 001-u01 001-t02 001-t03 >/dev/null || fail heard
node -e 'const s=require(process.argv[1]);if(s.reports.length!==1)process.exit(1);if(s.tasks.filter(t=>t.unitId==="001-u01"&&t.heard===false).length)process.exit(2)' "$F/incident.json" || fail "report not recorded or endings not heard"
out=$(seat_stop noscope:unit-leader l1 "$L"); expect_silent "$out" "seat hook ignores a leader"

step "the brief says which inferences the picture is standing on, and what rests on each"
# The unit's own picture cites an inferred claim, so its turn brief must list it with what
# would fall if it were wrong. Observed claims never appear: they are not being stood on.
node "$S/incident_brief.mjs" turn "$F/incident.json" 001-u01 > "$T/brief-resting.json"
node -e '
const b = require(process.argv[1]);
const r = b.restingOn;
if (!Array.isArray(r) || !r.length) { console.error("no restingOn block: " + Object.keys(b).join(", ")); process.exit(1); }
const c3 = r.find(x => x.claimId === "001-c03");
if (!c3) { console.error("the inferred claim the picture cites is missing: " + JSON.stringify(r)); process.exit(1); }
if (c3.confidence !== 0.65) { console.error("wrong confidence: " + c3.confidence); process.exit(1); }
if (!Array.isArray(c3.openItems) || !Array.isArray(c3.tasks)) { console.error("no openItems or tasks: " + JSON.stringify(c3)); process.exit(1); }
if (r.some(x => ["001-c01","001-c02"].includes(x.claimId))) { console.error("an observed claim was listed as an inference"); process.exit(1); }
' "$T/brief-resting.json" || fail "restingOn is wrong"

step "the resource request became a question; the unit waits; the answer releases it"
node -e 'const s=require(process.argv[1]);const u=s.units.find(u=>u.id==="001-u01");const q=s.questions.find(q=>q.unitId==="001-u01"&&!q.answer);if(u.status!=="waiting"||!q)process.exit(1);if(!s.reports.at(-1).pictureChanged)process.exit(2);console.log(q.id)' "$F/incident.json" > "$T/qid" || fail "resource request not raised"
node "$S/incident_next.mjs" "$F/incident.json" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{if(!JSON.parse(d).waiting.some(w=>w.unitId==="001-u01"))process.exit(1)})' || fail "next does not list the waiting unit"
node "$S/incident_apply.mjs" answer "$F/incident.json" "$(cat "$T/qid")" "Chrome" | grep -q "active again" || fail "answer did not release the unit"

step "a refused seat goes to the fallback model once, then the task ends failed with both refusals"
R1=$(seat_stop_raw noscope-planner-refusing r1 sess-r "I can't help with that request.")
expect_silent "$R1" "a refusal must not be pushed back"
grep -q "refused (1)" "$F/hooks/seat-stop.log" || fail "first refusal not traced"
# The planner runs on Sonnet 5 in this scenario, so its tier falls back to Sonnet 4.6, never up
# to an Opus, and the message must say the Agent tool cannot be asked for a generation.
grep -q "claude-sonnet-4-6" "$F/hooks/applied.jsonl" || fail "the first refusal did not name the tier's previous generation: $(tail -1 "$F/hooks/applied.jsonl")"
grep -q "claude-opus" "$F/hooks/applied.jsonl" && fail "a refused Sonnet seat was sent up a tier: $(tail -1 "$F/hooks/applied.jsonl")"
grep -q "cannot be asked for" "$F/hooks/applied.jsonl" || fail "the message does not say the Agent tool cannot name a generation"
# The launcher must know the role the hook tells a spawner to use, or the instruction is
# an address for a door that does not exist.
bash "$S/launch-session.sh" refusal_fallback "$F" claude-sonnet-4-6 ns-fb-test 2>&1 | grep -q "needs a task id" || fail "launch-session.sh does not know the refusal_fallback role"
grep -q "refusal_fallback" "$S/launch-session.sh" || fail "the launcher lost the refusal_fallback role"
R2=$(seat_stop_raw noscope-planner-refusing r2 sess-r "I'm not able to assist with this.")
expect_silent "$R2" "a second refusal must not be pushed back either"
grep -q "refused (2)" "$F/hooks/seat-stop.log" || fail "second refusal not traced"
grep -q "refused twice" "$F/hooks/applied.jsonl" || fail "the second refusal did not end the work"
# The object is what separates a refusal from a finding. A seat reporting that it could not
# find or reproduce something is doing its job; only declining the work is a refusal. Both
# directions are tested, because a false positive here sends good work to the fallback model
# and a false negative pushes a refusing seat back at the same model that just refused.
node --input-type=module -e '
const L = await import(process.argv[1]);
const refusals = ["I can\u0027t help with that request.", "I\u0027m not able to assist with this.",
  "I will not do that.", "I cannot assist with that task.", "I won\u0027t help with this.",
  "I\u0027m unable to help with that.", "I am not able to comply with this request.",
  "I decline to perform this action."];
const findings = ["Done. Here are the findings.", "I could not determine the cause from the evidence attached.",
  "I can\u0027t find the function in this file.", "I cannot reproduce the behaviour without a running app.",
  "The file cannot be read; it does not exist.", "I was unable to locate a second call site.",
  "I am able to help with the reading.", "I can\u0027t tell from the stack whether the remount fired."];
let bad = 0;
for (const s of refusals) if (!L.refusedCall(s)) { console.error("missed a refusal: " + s); bad++; }
for (const s of findings) if (L.refusedCall(s)) { console.error("read a finding as a refusal: " + s); bad++; }
process.exit(bad ? 1 : 0);
' "$P/hooks/lib.mjs" || fail "refusal detector misbehaves"

step "a large leader over large tasks is warned about; over smaller ones it is not"
# The validator only reads, so these run against the live record without disturbing it.
cat > "$T/plan-topheavy.json" <<JSON
{"createUnits":[{"ref":"big","parent":"001-command","type":"base","objective":"Work that is hard to decompose","scope":"the whole of the undecomposed work","leader":{"provider":"claude-code","model":"claude-fable-5-1"},"resourcesAssigned":["Read"],"bashAllowlist":[]}],
 "closeUnits":[],"cancelTasks":[],"questionsForHuman":[],"grantRequests":[],"resourceGaps":[],"applySops":[],"incidentStatus":"continue","rationale":"t",
 "createTasks":[{"ref":"x","unit":"big","resource":"investigate","objective":"a","scope":"file a","inputs":{},"expectedOutput":"x","completionCriteria":["d"],"evidenceRequired":[],"dependsOn":[],"instructions":"g","provider":"claude-code","model":"claude-opus-5","budget":{"seconds":300}},
                {"ref":"y","unit":"big","resource":"investigate","objective":"b","scope":"file b","inputs":{},"expectedOutput":"x","completionCriteria":["d"],"evidenceRequired":[],"dependsOn":[],"instructions":"g","provider":"claude-code","model":"claude-opus-5","budget":{"seconds":300}},
                {"ref":"z","unit":"big","resource":"investigate","objective":"c","scope":"file c","inputs":{},"expectedOutput":"x","completionCriteria":["d"],"evidenceRequired":[],"dependsOn":[],"instructions":"g","provider":"claude-code","model":"claude-opus-5","budget":{"seconds":300}}]}
JSON
out=$(node "$S/incident_validator.mjs" plan "$F/incident.json" "$T/plan-topheavy.json" "$CWD")
grep -q "a larger leader pays for itself by decomposing work onto smaller ones" <<<"$out" || fail "no warning for a large leader over equally large tasks: $out"
# The same unit with a modelWhy and smaller workers draws neither large-leader warning.
node -e '
const fs=require("fs");const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
p.createUnits[0].modelWhy="The objective names no steps; three parallel readings, all on Haiku.";
for (const t of p.createTasks) t.model="claude-haiku-4-5";
fs.writeFileSync(process.argv[2],JSON.stringify(p));' "$T/plan-topheavy.json" "$T/plan-balanced.json"
out=$(node "$S/incident_validator.mjs" plan "$F/incident.json" "$T/plan-balanced.json" "$CWD")
grep -q "puts a claude-fable-5-1 leader" <<<"$out" && fail "a large leader dispatching smaller workers should draw no warning: $out"
node -e 'const L=require(process.argv[1]+"/scripts/incident_lib.mjs")' 2>/dev/null
node --input-type=module -e '
const L=await import(process.argv[1]);
if(!L.AVAILABLE_MODELS.includes("claude-fable-5-1")) { console.error("fable missing from AVAILABLE_MODELS"); process.exit(1); }
if(L.priceOf("claude-fable-5-1",0,1e6,{})!==50) { console.error("fable prices as "+L.priceOf("claude-fable-5-1",0,1e6,{})+", expected 50"); process.exit(1); }
' "$S/incident_lib.mjs" || fail "fable is namable but not priced; its seats would log as free"

step "a missing_means request becomes a resource gap, not a question"
G='{"unitId":"001-u01","kind":"report","report":{"outcome":"progress","changed":[],"pictureChanged":false,"situation":{"picture":"The page container scrolls after a delete.","evidence":[],"open":[{"what":"what the running app does on deletion","settledBy":"a resource that drives a browser"}],"changed":"nothing yet"},"resourceRequests":[{"kind":"missing_means","what":"a resource that can drive a real browser","why":"the link cannot be settled by reading"}]},"assignTasks":[],"consult":[]}'
echo "$G" > "$T/leader-gap.json"
node "$S/incident_apply.mjs" report "$F/incident.json" "$T/leader-gap.json" 001-u01 | grep -q "resource gap" || fail "missing_means did not become a resource gap"
node -e '
const s=require(process.argv[1]);
const g=(s.resourceGaps??[]).at(-1);
if(!g) { console.error("no resource gap recorded"); process.exit(1); }
if(!/^001-g\d+$/.test(g.id)) { console.error("gap id is "+g.id+"; expected the g prefix"); process.exit(1); }
if((s.questions??[]).some(q=>q.text===g.need)) { console.error("missing_means also became a question"); process.exit(1); }
' "$F/incident.json" || fail "resource gap not recorded under the g prefix"
grep -q '"type":"resource.gap"' "$F/log.jsonl" || fail "resource.gap event not logged"


step "the IC brief carries only changed keys after a turn; whole on request"
node "$S/incident_brief.mjs" ic "$F/incident.json" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d);if(!o.unchanged||!o.unchanged.includes("resources")||!("reports" in o.incident))process.exit(1)})' || fail "ic brief not narrowed to changed keys"
node "$S/incident_brief.mjs" ic "$F/incident.json" --whole | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const o=JSON.parse(d);if(o.unchanged||!("resources" in o.incident))process.exit(1)})' || fail "ic brief --whole not whole"

step "a saved config is kept for later incidents (the machine's configs.json is restored afterwards)"
CFG="$HOME/.claude/noscope/configs.json"; [ -f "$CFG" ] && cp "$CFG" "$T/configs.bak"
node "$S/incident_apply.mjs" config "$F/incident.json" observation-unit 001-u01 | grep -q 'saved from 001-u01' || fail "config save"
node -e 'const s=require(process.argv[1]);if(!s.configs.some(c=>c.name==="observation-unit"))process.exit(1)' "$F/incident.json" || fail "config not in state"
grep -q observation-unit "$CFG" || fail "config not saved for later incidents"
if [ -f "$T/configs.bak" ]; then cp "$T/configs.bak" "$CFG"; else rm -f "$CFG"; fi

step "after-tool hook reports what the hooks applied"
hook_in '{"tool_name":"Agent","tool_input":{},"tool_response":{}}'; out=$(node "$H/noscope-after-tool.mjs" < "$T/in.json")
grep -q "applied by hook" <<<"$out" || fail "after-tool reported nothing: $out"

step "record guard"
hook_in '{"tool_name":"Edit","tool_input":{"file_path":"'"$F"'/incident.json"}}'; node "$H/noscope-guard-record.mjs" < "$T/in.json" 2>/dev/null && fail "record guard let an edit through"

step "every hook is in exec form, so no shell parses its command line"
cat > "$T/exec-form.js" <<'JS'
const d = require(process.argv[2]);
const bare = /^[A-Za-z0-9._\/-]+$/;          // a plain executable name or path, nothing a shell would reinterpret
const bad = [];
for (const [event, groups] of Object.entries(d.hooks))
  for (const g of groups)
    for (const h of g.hooks) {
      if (!Array.isArray(h.args)) bad.push(event + ": " + h.command + " has no args, so a shell tokenizes it");
      else if (!bare.test(h.command)) bad.push(event + ": command " + JSON.stringify(h.command) + " is not a bare executable");
    }
if (bad.length) { console.error(bad.join("\n")); process.exit(1); }
JS
node "$T/exec-form.js" "$P/hooks/hooks.json" || fail "hooks.json left shell form behind; a model id or an apostrophe in an argument would be reparsed"

step "the gate: its sessions directory is the one the scripts write"
lib=$(node --input-type=module -e 'const m=await import(process.argv[1]);process.stdout.write(m.SESSIONS_DIR)' "$S/incident_lib.mjs")
# Read the assignment out of the gate itself and expand it, so this compares what the gate uses
# and not a second copy of the same string written here.
assign=$(grep -m1 '^SESSIONS=' "$H/noscope-gate.sh" | cut -d= -f2-)
[ -n "$assign" ] || fail "noscope-gate.sh has no SESSIONS= line; this step cannot check the paths agree"
gate=$(eval "echo $assign")
[ "$lib" = "$gate" ] || fail "incident_lib.mjs writes markers to $lib but noscope-gate.sh reads $gate"

step "the gate runs a hook for a joined session and skips it for every other"
node "$S/incident_session.mjs" join "$F" >/dev/null || fail "join"
[ -f "$SESSIONS/$NOSCOPE_SESSION_ID" ] || fail "join wrote no marker"
[ "$(cat "$SESSIONS/$NOSCOPE_SESSION_ID")" = "$F" ] || fail "the marker names the wrong run folder"
# The record guard refuses a hand edit of incident.json. Through the gate it must still refuse
# for the joined session, and must not even run for a session that never joined.
guard_in() { node -e 'const fs=require("fs");const [f,cwd,sid,p]=process.argv.slice(1);fs.writeFileSync(f,JSON.stringify({cwd,session_id:sid,hook_event_name:"PreToolUse",tool_name:"Write",tool_input:{file_path:p}}))' "$T/in.json" "$CWD" "$1" "$F/incident.json"; }
guard_in "$NOSCOPE_SESSION_ID"
bash "$H/noscope-gate.sh" noscope-guard-record.mjs < "$T/in.json" 2>"$T/gate.err"; code=$?
[ "$code" = 2 ] || fail "the gate did not run the record guard for a joined session (exit $code)"
grep -q "written only by the scripts" "$T/gate.err" || fail "the record guard ran but said nothing: $(cat "$T/gate.err")"
guard_in "some-unrelated-session"
bash "$H/noscope-gate.sh" noscope-guard-record.mjs < "$T/in.json" 2>"$T/gate.err"; code=$?
[ "$code" = 0 ] || fail "the gate ran a hook for a session that never joined (exit $code)"
[ -s "$T/gate.err" ] && fail "the gate let a hook speak to an unjoined session: $(cat "$T/gate.err")"

step "only the IC is told to take command; a task seat is told what it is"
sess_in() { node -e 'const fs=require("fs");const [f,cwd]=process.argv.slice(1);fs.writeFileSync(f,JSON.stringify({cwd,session_id:"role-probe",hook_event_name:"SessionStart"}))' "$T/in.json" "$CWD"; }
sess_in
out=$(NOSCOPE_ROLE=task NOSCOPE_TASK=001-t99 NOSCOPE_RUN="$F" node "$H/noscope-session-start.mjs" < "$T/in.json")
case "$out" in *noscope-resume*) fail "a task seat was told to take command of the incident: $out";; esac
case "$out" in *001-t99*) ;; *) fail "a task seat was not told which task it runs: $out";; esac
out=$(NOSCOPE_ROLE=some-future-role NOSCOPE_RUN="$F" node "$H/noscope-session-start.mjs" < "$T/in.json")
case "$out" in *noscope-resume*) fail "a role this hook has never heard of inherited the IC instruction: $out";; esac
out=$(node "$H/noscope-session-start.mjs" < "$T/in.json")
case "$out" in *noscope-resume*) ;; *) fail "the IC was not told how to take command: $out";; esac
rm -f "$SESSIONS/role-probe"

step "SessionStart is not gated: it reaches a session that has not joined"
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({cwd:process.argv[2],session_id:"some-unrelated-session",hook_event_name:"SessionStart"}))' "$T/in.json" "$CWD"
node "$H/noscope-session-start.mjs" < "$T/in.json" | grep -q "noscope-resume" || fail "SessionStart said nothing to an unjoined session in an incident's directory"
[ -e "$SESSIONS/some-unrelated-session" ] && fail "SessionStart marked a session that only shares the directory"

step "accepting command turn, then the loop hook lets the session stop"
RID=$(node -e 'const s=require(process.argv[1]);console.log(s.reports.at(-1).id)' "$F/incident.json")
cat > "$F/turn-2.json" <<JSON
{"periodObjectives":["Record the answer: the page container scrolls after a deletion; the rail does not"],"priorities":["observation over reading"],
 "reportVerdicts":[{"reportId":"$RID","unitId":"001-u01","verdict":"accepted","instructions":"","why":"two reproductions measured both containers; both claims observed"}],
 "situation":{"picture":"The page container scrolls to the bottom after a middle comment is deleted; the rail does not.","evidence":[{"claimId":"001-c01","stance":"for"},{"claimId":"001-c02","stance":"for"},{"claimId":"001-c03","stance":"for"}],"open":[{"id":"001-o01","what":"a running app to reproduce on","settledBy":"settled by 001-t02","deferred":"settled; kept to record the closure"}],"assessment":{"kind":"on_track","why":"met on observed claims"},"changed":"rests on observed claims"},
 "closeUnits":[],"assignTasks":[],"questionsForHuman":[],"resourceGaps":[],"grantRequests":[],"incidentStatus":"satisfied","rationale":"met"}
JSON
node "$S/incident_validator.mjs" command "$F/incident.json" "$F/turn-2.json" >/dev/null || fail "turn 2 rejected"
[ -f "$SESSIONS/$NOSCOPE_SESSION_ID" ] || fail "the gate steps left this session unjoined, so the stand-down below would prove nothing"
node "$S/incident_apply.mjs" command "$F/incident.json" "$F/turn-2.json" | grep -q satisfied || fail "turn 2 apply"
[ -e "$SESSIONS/$NOSCOPE_SESSION_ID" ] && fail "the incident was satisfied and its session's marker survived it"
node -e 'const s=require(process.argv[1]);if(s.units.some(u=>u.status!=="closed"&&u.id!=="001-command"))process.exit(1);if(s.tasks.some(t=>["pending","ready","running"].includes(t.status)))process.exit(2)' "$F/incident.json" || fail "the terminal turn left a unit or task open"
out=$(hook_in '{"hook_event_name":"Stop"}'; node "$H/noscope-loop.mjs" < "$T/in.json"); expect_silent "$out" loop-end

step "run.json takes only fields it has, so a mistyped key is refused not invented"
node "$S/incident_apply.mjs" run "$F/incident.json" icSession '"IC-scenario"' | grep -q "icSession" || fail "a real run.json field was refused"
node -e 'const r=require(process.argv[1]);if(r.icSession!=="IC-scenario")process.exit(1)' "$F/run.json" || fail "icSession did not land"
node "$S/incident_apply.mjs" run "$F/incident.json" icSesion '"typo"' >/dev/null 2>&1 && fail "a mistyped run.json key was accepted; a leader would address a commander named nowhere"
node -e 'const r=require(process.argv[1]);if("icSesion" in r)process.exit(1)' "$F/run.json" || fail "the mistyped key was written anyway"
node "$S/incident_apply.mjs" run "$F/incident.json" heartbeat.cronId '"cron-1"' >/dev/null || fail "a nested run.json field was refused"
node -e 'const r=require(process.argv[1]);if(r.heartbeat.cronId!=="cron-1")process.exit(1)' "$F/run.json" || fail "the nested field did not land"

step "the human sets a bound mid-run, and lifting it unblocks the pass"
# Spend something, then bound the run at exactly that, so the next pass has nothing left.
node "$S/incident_apply.mjs" call "$F/incident.json" ic claude-sonnet-5 1000 200 30 >/dev/null || fail "call not logged"
SPENT=$(node -e 'const s=require(process.argv[1]);process.stdout.write(String(s.incident.spent.tokens??0))' "$F/incident.json")
[ "$SPENT" -gt 0 ] || fail "logging a call did not move incident.spent.tokens"
node "$S/incident_apply.mjs" budget "$F/incident.json" tokens "$SPENT" | grep -q "bound is $SPENT" || fail "budget not set"
node -e 'const s=require(process.argv[1]);if(s.incident.budget.tokens!==Number(process.argv[2]))process.exit(1)' "$F/incident.json" "$SPENT" || fail "the bound is not in the record"
node "$S/incident_next.mjs" "$F/incident.json" | grep -q "the budget is spent" || fail "a spent bound does not block the pass"
node "$S/incident_apply.mjs" budget "$F/incident.json" tokens none | grep -q "lifted" || fail "budget not lifted"
node "$S/incident_next.mjs" "$F/incident.json" | grep -q "the budget is spent" && fail "the pass still blocks after the bound was lifted"
node "$S/incident_apply.mjs" budget "$F/incident.json" hours 5 >/dev/null 2>&1 && fail "budget accepted a dimension it does not have"
node "$S/incident_apply.mjs" budget "$F/incident.json" tokens -3 >/dev/null 2>&1 && fail "budget accepted a negative bound"

step "trust is lent for the incident and the repository is left as it was found"
# A HOME of its own: this must never touch the machine's real ~/.claude.json.
TH="$T/trust-home"; mkdir -p "$TH/.claude/noscope"
echo '{"projects":{}}' > "$TH/.claude.json"
echo '{"preAccept":true}' > "$TH/.claude/noscope/config.json"
trust() { HOME="$TH" node "$S/incident_trust.mjs" "$@"; }
has_flag() { python3 -c "
import json,sys
d=json.load(open(sys.argv[1]))
print('yes' if d['projects'].get(sys.argv[2],{}).get('hasTrustDialogAccepted') is True else 'no')" "$TH/.claude.json" "$CWD"; }
[ "$(has_flag)" = no ] || fail "the scratch repo starts trusted, so this step would prove nothing"
trust grant "$CWD" "$F" >/dev/null || fail "grant"
[ "$(has_flag)" = yes ] || fail "grant did not suppress the dialog"
trust grant "$CWD" "$F-other" >/dev/null || fail "second grant"
trust release "$F" >/dev/null || fail "release"
[ "$(has_flag)" = yes ] || fail "trust was put back while another run still held it"
trust release "$F-other" >/dev/null || fail "release the last holder"
[ "$(has_flag)" = no ] || fail "the incident ended and the repository was left trusted"
HOME="$TH" node "$S/incident_trust.mjs" release "$F" | grep -q "nothing was lent" || fail "releasing twice should say there is nothing to put back"
echo '{"preAccept":false}' > "$TH/.claude/noscope/config.json"
trust grant "$CWD" "$F" | grep -q "preAccept is off" || fail "grant ignored preAccept being off"
[ "$(has_flag)" = no ] || fail "preAccept was off and the dialog was suppressed anyway"

step "a human stop closes the run in the record; hooks treat it as ended"
node "$S/incident_apply.mjs" stop "$F/incident.json" "test stop" | grep -q "incident stopped" || fail "stop mode"
node -e 'const s=require(process.argv[1]);if(s.incident.status!=="stopped")process.exit(1)' "$F/incident.json" || fail "status not stopped"
out=$(hook_in '{"hook_event_name":"Stop"}'; node "$H/noscope-loop.mjs" < "$T/in.json"); expect_silent "$out" loop-stopped
node "$S/incident_report.mjs" "$F/incident.json" | grep -q "stopped by a human" || fail "report does not say stopped"

step "a session in a directory whose incident has ended logs nothing into that record"
before=$(grep -c '"type":"call"' "$F/log.jsonl")
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({cwd:process.argv[2],hook_event_name:"Stop",session_id:"sess-after-the-end",transcript_path:process.argv[3]}))' "$T/in.json" "$CWD" "$T/fake-transcript.jsonl"
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1], JSON.stringify({type:"assistant",uuid:"u1",timestamp:new Date().toISOString(),message:{model:"claude-sonnet-5",usage:{input_tokens:10,output_tokens:20,cache_read_input_tokens:0,cache_creation_input_tokens:0}}}) + "\n");' "$T/fake-transcript.jsonl"
node "$H/noscope-log-turn.mjs" < "$T/in.json"
after=$(grep -c '"type":"call"' "$F/log.jsonl")
[ "$before" = "$after" ] || fail "the turn hook logged into an ended incident: $before -> $after call(s)"

step "the planner is handed what it plans from, not the whole record"
node "$S/incident_brief.mjs" planner "$F/incident.json" > "$T/pb.json" || fail "no planner brief"
node "$S/incident_validator.mjs" brief "$F/incident.json" "$T/pb.json" planner >/dev/null || fail "the composed planner brief does not pass its own check"
cat > "$T/pb.js" <<'JS'
const fs = require("fs");
const b = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const bad = [];
const base = b.incident || {};
for (const k of ["incident","period","situation","units","claims","openTasks","evidence","reassignments","questions","resources"])
  if (!(k in base)) bad.push("the base lacks " + k);
if ("tasks" in base) bad.push("the base still carries every task");
if (!b.sinceLastPlan) bad.push("no sinceLastPlan, so a fresh planner cannot tell what the last plan did");
// A claim reaches the planner as a line: what it says and how firmly, not its measured object.
for (const c of base.claims || []) if ("object" in c || "provenance" in c) { bad.push("claims are not lines: " + JSON.stringify(c).slice(0,80)); break; }
// Nothing completed should be in openTasks; those belong to sinceLastPlan.
for (const t of base.openTasks || []) if (!["pending","ready","running"].includes(t.status)) bad.push("openTasks holds a " + t.status + " task");
if (bad.length) { console.error(bad.join("; ")); process.exit(1); }
JS
node "$T/pb.js" "$T/pb.json" || fail "the planner brief is not composed as intended"
# It must be smaller than handing over the record.
node -e '
const fs=require("fs");
const whole=fs.statSync(process.argv[1]).size, brief=JSON.parse(fs.readFileSync(process.argv[2],"utf8"));
const base=JSON.stringify(brief.incident).length;
if (base >= whole) { console.error(`the planner base is ${base} bytes against a ${whole}-byte record; it is not a slice`); process.exit(1); }
' "$F/incident.json" "$T/pb.json" || fail "composing the planner base saved nothing"

step "the audit reads the run and finds nothing wrong with a clean one"
node "$S/incident_audit.mjs" "$F" > "$T/audit.txt" || fail "the audit did not run"
grep -q "WHERE THE BYTES ARE" "$T/audit.txt" || fail "the audit printed no composition"
grep -q "THE STATE" "$T/audit.txt" || fail "the audit printed no state breakdown"
grep -q "WHAT TO FIX" "$T/audit.txt" || fail "the audit printed no findings section"
# This run stores a line per task and a pointer, so the bloat checks must not fire on it.
grep -q "keep their body in the record" "$T/audit.txt" && fail "the audit says tasks keep their body, after 0.20.0 made them a line"
grep -q "left no line saying what happened" "$T/audit.txt" && fail "the audit says a task left no summary, which the validator now requires"
node "$S/incident_audit.mjs" /nonexistent >/dev/null 2>&1 && fail "the audit ran on a folder with no incident.json"
# The metrics object is what the tables are drawn from, and what --record keeps.
node "$S/incident_audit.mjs" "$F" --json > "$T/metrics.json" || fail "the audit emitted no metrics object"
node -e 'const m=require(process.argv[1]);const need=["run","shape","bytes","stateSections","tokens","seats","checks","findings"];const miss=need.filter(k=>!(k in m));if(miss.length){console.error("missing: "+miss.join(", "));process.exit(1)}' "$T/metrics.json" || fail "the metrics object is missing a section"
node "$S/incident_audit.mjs" "$F" --record >/dev/null || fail "the audit could not record"
REC="$T/incidents/metrics.jsonl"
[ -f "$REC" ] || fail "no metrics.jsonl was written beside the projects"
[ "$(wc -l < "$REC" | tr -d " ")" = "1" ] || fail "recording one run wrote more than one line"
node "$S/incident_audit.mjs" "$F" --record >/dev/null
[ "$(wc -l < "$REC" | tr -d " ")" = "1" ] || fail "re-auditing the same run appended a second line instead of replacing it"
node "$S/incident_audit.mjs" --compare "$T/incidents" | grep -q "recorded run" || fail "the recorded runs do not compare"

step "a file being written is reserved; a second worker takes what is free and waits for the rest"
RESV_A=$(node -e 'const s=require(process.argv[1]);const t=s.tasks.find(x=>x.unitId);if(!t){console.error("no task carries a unitId");process.exit(1)}console.log(t.id)' "$F/incident.json") || fail "could not find a task to reserve against"
RESV_UNIT=$(node -e 'const s=require(process.argv[1]);console.log(s.tasks.find(x=>x.id===process.argv[2]).unitId)' "$F/incident.json" "$RESV_A")
[ -n "$RESV_UNIT" ] || fail "a task carries no unit id; the reservation code reads the wrong field"

node "$S/incident_apply.mjs" reserve "$F/incident.json" "$RESV_A" src/scroll.ts >/dev/null || fail "a free file could not be reserved"
node -e 'const s=require(process.argv[1]);const r=(s.reservations||[]).find(x=>x.path==="src/scroll.ts");if(!r||r.by!==process.argv[2]||r.unit!==process.argv[3])process.exit(1)' "$F/incident.json" "$RESV_A" "$RESV_UNIT" || fail "the reservation did not record both its worker and that worker's unit"

# A worker asking again for what it already holds is not in conflict with itself.
node "$S/incident_apply.mjs" reserve "$F/incident.json" "$RESV_A" src/scroll.ts >/dev/null || fail "a worker conflicted with its own reservation"

# The second worker wants one held file and one free one. It must get the free one and wait for
# the other: blocking the whole request would throw away the parallelism this exists to protect.
OUT=$(node "$S/incident_apply.mjs" reserve "$F/incident.json" "$RESV_UNIT" src/scroll.ts src/other.ts; echo "rc=$?")
case "$OUT" in *"rc=3"*) ;; *) fail "a held file did not put the second worker into waiting (got: $OUT)";; esac
case "$OUT" in *"notify:"*) ;; *) fail "a waiting reservation did not say who to tell";; esac
node -e 'const s=require(process.argv[1]);const r=(s.reservations||[]).find(x=>x.path==="src/other.ts");if(!r||r.by!==process.argv[2])process.exit(1)' "$F/incident.json" "$RESV_UNIT" || fail "the free file was not taken; a worker must get on with what it can have"
node -e 'const s=require(process.argv[1]);if((s.reservations||[]).some(x=>x.path==="src/scroll.ts"&&x.by===process.argv[2]))process.exit(1)' "$F/incident.json" "$RESV_UNIT" || fail "a held file was handed to a second worker"
node -e 'const s=require(process.argv[1]);const w=(s.fileWaits||[]).find(x=>x.path==="src/scroll.ts"&&x.by===process.argv[2]);if(!w||w.heldBy!==process.argv[3])process.exit(1)' "$F/incident.json" "$RESV_UNIT" "$RESV_A" || fail "the wait was not recorded against its holder"

# Releasing names the worker that was waiting, rather than announcing it to nobody.
REL=$(node "$S/incident_apply.mjs" release "$F/incident.json" "$RESV_A" src/scroll.ts) || fail "a reservation could not be released"
case "$REL" in *"$RESV_UNIT"*) ;; *) fail "releasing a waited-for file did not name the waiting worker (got: $REL)";; esac

# A circle of waits can never resolve itself, so it is reported at once instead of waited on.
# Each worker holds what the other wants: A holds one file, the unit holds the other.
node "$S/incident_apply.mjs" release "$F/incident.json" "$RESV_A" >/dev/null
node "$S/incident_apply.mjs" release "$F/incident.json" "$RESV_UNIT" >/dev/null
node "$S/incident_apply.mjs" reserve "$F/incident.json" "$RESV_A" src/left.ts >/dev/null || fail "could not set up the circle"
node "$S/incident_apply.mjs" reserve "$F/incident.json" "$RESV_UNIT" src/right.ts >/dev/null || fail "could not set up the circle"
node "$S/incident_apply.mjs" reserve "$F/incident.json" "$RESV_UNIT" src/left.ts >/dev/null 2>&1   # now waiting on A
DL=$(node "$S/incident_apply.mjs" reserve "$F/incident.json" "$RESV_A" src/right.ts; echo "rc=$?")
case "$DL" in *"rc=4"*) ;; *) fail "a circle of waits was not reported as a deadlock (got: $DL)";; esac
case "$DL" in *DEADLOCK*) ;; *) fail "the deadlock was not named as one";; esac

node "$S/incident_apply.mjs" release "$F/incident.json" "$RESV_A" >/dev/null
node "$S/incident_apply.mjs" release "$F/incident.json" "$RESV_UNIT" >/dev/null
node -e 'const s=require(process.argv[1]);if((s.reservations||[]).length!==0)process.exit(1)' "$F/incident.json" || fail "releasing everything left a reservation behind"

step "a seat with no reason to write cannot write"
cat > "$T/ro.js" <<'JS'
const fs = require("fs");
const bad = [];
const WRITERS = ["Write", "Edit", "NotebookEdit", "Bash"];
for (const f of process.argv.slice(2)) {
  const head = fs.readFileSync(f, "utf8").split("---")[1] ?? "";
  const m = /^tools:\s*(.+)$/m.exec(head);
  const name = f.split("/").pop();
  if (name === "planner.md") {
    if (!m) { bad.push("the planner declares no tools, so it holds every tool including Write"); continue; }
    const held = m[1].split(",").map((x) => x.trim().replace(/^\[|\]$/g, "").replace(/"/g, ""));
    const writes = held.filter((t) => WRITERS.includes(t));
    if (writes.length) bad.push(`the planner may use ${writes.join(", ")}; it proposes structure and writes nothing`);
  }
}
if (bad.length) { console.error(bad.join("; ")); process.exit(1); }
JS
node "$T/ro.js" "$P"/agents/*.md || fail "a seat that must not write can write"

step "review"
node "$S/incident_review.mjs" "$F/incident.json" | head -3
node --input-type=module -e 'const lib=await import(process.argv[1]); const m=lib.loadCurrent(); delete m[process.argv[2]]; lib.saveCurrent(m)' "$S/incident_lib.mjs" "$CWD" || fail "pointer cleanup"
rm -f "$HOME/.warp/tab_configs/noscope-scenario-leader.toml" "$UP"   # the launcher steps wrote these outside the scratch dir
rm -f "$SESSIONS/$NOSCOPE_SESSION_ID"                               # and this, if a step left it behind
echo "PASS: run folder $F"
