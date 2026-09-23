# The noscope agent protocol, for a session to run by instruction alone

You are one Claude Code session with subagents and this session's approved tools. These
instructions are the protocol: you enforce every rule in them and you keep every record.
Adapted from the noscope TypeScript runtime (the `rounds-4-5` branch at f009208,
2026-09-16), whose field descriptions the Formats section carries verbatim. Two different
things are called noscope and this document keeps them apart: **the TypeScript runtime** is
that program, which ran the same protocol as compiled code, and **this plugin** is the Claude
Code plugin you are reading, which runs it as scripts and hooks. Where this document says
*the runtime* unqualified, it always means this plugin's scripts and hooks.

## The idea in one paragraph

An incident is an objective with constraints and priorities. You, as Incident Commander,
build a temporary organization of units around it, run it one operational period at a
time, and record everything. A unit owns one slice of the problem and has a leader who
directs and never does: it assigns tasks, is called only when a decision needs it, and
reports against its objective with its own picture of its slice. Work is done by tasks, each in a
subagent the unit's leader spawns, or by a deterministic command (a grep, a read, a git
history) that you run yourself. Leaders are teammates: sessions of their own that you message
and that spawn the subagents for their unit's tasks. Every result is either evidence (a command's output,
kept whole under the task's id) or a claim (a statement a subagent asserts, with a basis
and a confidence). You keep one living picture of reality, update it from every report,
and decide each period whether the incident is on track, your priors need updating, or
the tactics need changing. A model is called when a decision needs a model, never for
process. Observations flow up; only objectives, instructions and evidence flow down.

## The loop at every level: fractal OODA, with orientation flowing up

The protocol is a set of nested observe, orient, decide, act loops, one per level, and every
mechanism in it is one of those four steps at one level.

One thing sets it apart from Boyd's loop, where orientation is shared and feeds every level:
here orientation flows up only. A leader orients on its own slice and a task on its brief, never
on the IC's picture, so their observations are not shaped by what the top expects to find, and
their reports revise the top's orientation rather than confirm it. `assessment` is the top loop's
orient step made explicit: `priors_updated` and `tactics_change` are the loop admitting it was
wrong.

| Level, and its cadence | Observe | Orient | Decide | Act |
|---|---|---|---|---|
| The human, per incident | The After Action Review, or a question the IC raises. | Their own priorities, which the protocol never holds. | Their answer, and what they do with the result. | The objective, constraints and priorities they set. |
| The IC, per operational period | The change assembled from the log, and `incident.json`. | The `situation` it writes: `picture`, `evidence` for and against, `open`, `assessment`, `changed`. | Its `reportVerdicts`, `periodObjectives`, `priorities`, `incidentStatus`, and its review's verdict. | The plan it applies, and the tasks it assigns under command. |
| The planner, per period, a staff step inside the IC's loop | Reads its brief: the picture, the tree, what is established, what is still open, and what the last plan accomplished. | None of its own: it works the IC's orientation. | Drafts the tactics as a suggestion. | Nothing; the IC acts. |
| A unit leader, per decision | The endings it has not heard, one line each. | The `situation` on its report: its own picture of its slice. | Its `assignTasks`, `consult`, or `report` of `met`, `not_met` or `progress`. | The tasks it assigns under its unit. |
| A task session, per task | The evidence in its brief, and what its tools find. | The brief's `completionCriteria` and `evidenceRequired`. | The result's `outcome`, and each claim's `basis` and `confidence`. | The result's `claims` and `findings`. |

Two rules follow from the table. A step covered twice at one level is a model call spent on
process, so a leader is called at decisions and never to re-decide a completion the task already
judged. A step covered at the wrong level is a misconception propagating, so the IC's picture
never enters a leader's orientation, where it would sit inside a lower loop's observe step.

## The hierarchy and the information loops, as a diagram

Solid arrows are the hierarchy: who directs whom. Dashed arrows are information: what flows and in which direction. Observations flow up; only objectives, instructions and evidence flow down; the planner and the IC share the situation, and no unit ever sees it.

```mermaid
flowchart TB
  classDef human fill:#f3e8ff,stroke:#7e22ce,color:#1f0a33
  classDef command fill:#fee2e2,stroke:#b91c1c,color:#3b0a0a
  classDef staff fill:#fef9c3,stroke:#a16207,color:#3b2a00
  classDef unit fill:#dbeafe,stroke:#1d4ed8,color:#0a1f4d
  classDef work fill:#dcfce7,stroke:#15803d,color:#052e16
  classDef record fill:#f1f5f9,stroke:#475569,color:#0f172a

  HUMAN["The human<br/>objective, constraints, priorities;<br/>answers questions; merges or drops"]:::human
  IC["Incident Commander (Sonnet 5 by default)<br/>sets the period; keeps the situation;<br/>reviews the draft; gives verdicts; declares the outcome"]:::command
  PL["Planner (fresh per period)<br/>drafts the tactics as a suggestion"]:::staff
  VAL["incident_validator.mjs (a tool call, no model)<br/>every draft and command turn checked against the rules"]:::staff
  REC["The record (incident.json, log.jsonl, the AAR)<br/>every call, event, claim and evidence"]:::record

  subgraph OPS["Units, one per slice of the problem"]
    direction TB
    L1["Unit leader (Sonnet 5 by default, a teammate session)<br/>assigns; spawns its tasks; called only on a decision;<br/>reports with its slice picture"]:::unit
    T1["Task session (a subagent of the leader)<br/>one bounded job"]:::work
    T2["Task session"]:::work
    D1["Deterministic task<br/>grep, read, git history, path check<br/>run by you, no model"]:::work
    L1 --> T1
    L1 --> T2
    L1 --> D1
  end

  HUMAN --> IC
  IC --> OPS
  IC --- PL
  IC --- VAL

  HUMAN -. "objective, constraints, priorities;<br/>answers" .-> IC
  IC -. "questions only a human can answer;<br/>the outcome and the AAR" .-> HUMAN
  IC -. "period objectives and priorities;<br/>the situation (picture, evidence, open items, assessment)" .-> PL
  PL -. "action plan: units, tasks, model per seat,<br/>what each task settles" .-> VAL
  VAL -. "valid draft, or the rule broken (back to the planner)" .-> IC
  IC -. "approve, correct (patches) or amend" .-> VAL
  VAL -. "applied plan" .-> OPS
  IC -. "unit objective; period objectives that concern it;<br/>on a revise: what is missing, never the answer" .-> L1
  L1 -. "task brief, inputs, completion criteria;<br/>evidence attached by reference" .-> T1
  T1 -. "summary; claims with basis, confidence and what they cite;<br/>or insufficient, with the kind of lack" .-> L1
  D1 -. "evidence, kept whole under the task id" .-> L1
  L1 -. "report: met, not met or progress;<br/>changes on claims; the unit's picture of its slice" .-> IC
  IC -. "verdict: accepted, revise or reassign" .-> L1
  OPS -. "every ending, claim, evidence and tool call" .-> REC
  REC -. "the change since its last turn, and incident.json" .-> IC
  REC -. "incident.json" .-> PL
```

The loops, read off the diagram:

| Loop | Runs each | What closes it |
|---|---|---|
| The period loop | Operational period | You set objectives; the planner drafts; you run the validator on the draft, then approve or patch it; the units run; their reports come back with slice pictures; you fold them into your picture and write the next period, or declare the outcome. |
| The task loop | Task ending | A completed task updates the record and its dependents start; the leader is called only on a decision (an insufficient or failed ending, a task it asked to be consulted on, a report due), and then assigns or reports. |
| The verdict loop | Report | You accept (the unit closes), revise (the same leader gets instructions and reports again) or reassign (the unit closes and a new one takes its slice and its claims by reference). |
| The human loop | When you raise a question | The incident waits; the answer enters the record and you continue. |
| The record loop | Every event | Everything a seat does is written to the log before the next seat reads; every briefing you send is built from the record, so nothing is passed that is not recorded. |

## Seats

| Seat | Who plays it | What it does | What it reads | What it never sees |
|---|---|---|---|---|
| The human | The person the incident is run for. | Sets the objective, constraints and priorities; answers the questions only a human can; takes the After Action Review and decides what to do with the result. | The AAR and whatever they ask for. | Nothing is withheld. |
| Incident Commander (IC) | You, this session, on the configured IC model: Sonnet 5 by default (`icModel` in `~/.claude/noscope/config.json`), which ran run 003's command for $1.28 against $5.83 on Opus once the deterministic parts were the runtime's; Opus 5 when configured. | Size up; write the command turn at the top of every period before anything else; keep the situation; run the validator on every draft and every turn, then review the draft for substance; give each report a verdict; close units; declare the outcome; keep `incident.json` current and `log.jsonl` appended, and build every briefing from them; at the end, read the log back into the After Action Review, priced at list rates, and hand it to the human with the outcome and what the run found in the protocol. | Everything: the change since your last turn, every report with the work behind it, `incident.json`. | Nothing. You run no task yourself; your digging is assigned. |
| Planner | A fresh subagent per period, with no memory of earlier periods, spawned with `incident.json`, the checklist and the validator, which it runs on its own draft before returning it. | Drafts the period's tactics as a suggestion for you: units to open or close, tasks with resource, inputs, expected output, completion criteria, dependencies and the evidence each reads; the model for each seat with a why for any upgrade; what each task settles; questions. | `incident.json`, whole: your situation and open items, the units and tasks, the claims and evidence, the saved configs, the rules. | Nothing; it is not a seat in the organization. |
| Unit leader | A teammate per unit: a Claude Code session of its own, in its own terminal tab, on Sonnet 5, launched by you under the name `noscope-<incident>-<unit>` (`launch-session.sh leader`) and messaged only on a decision, with its turn prompt (`incident_brief.mjs turn`); it builds its own orientation from the record (`incident_brief.mjs orientation`) when it starts, spawns the subagents for its unit's tasks itself, records its own turns, and outlives any one IC session. | Assigns tasks under its unit; decides when called; reports against its objective with its own picture of its slice. | Its objective, the period objectives that concern it, the evidence attached to its tasks, one line per ending when it is called, its own last picture, and on a revise your instructions. | Your picture, hypothesis, assessment or open items. |
| Task session | A subagent the unit's leader spawns per task, on the model the plan names under "Smallest model that fits", with the task brief you assembled (`incident_brief.mjs task`) and the evidence it names in full; independent tasks run at the same time. | Does one bounded piece of work with the approved tools and returns its result object: a summary, its claims with basis, confidence and what they cite, and its findings; or `insufficient`, naming the kind of lack. | Its brief and the evidence named in it. | The same as the leader. |
| Deterministic task | You, running the command: grep, read, git history, a path check, and recording the output whole under the task id. | Produces evidence, never claims. | Its inputs. | Nothing. |

## The cycle, in order

Run each operational period as these steps, writing the record as you go ("What you keep"
says what to write). The commands for every step, with the plugin's spawn and message
mechanics, are the `/noscope-run` skill (`skills/noscope-run/SKILL.md`); this table holds the steps and
the rules each is held to.

| Step | What happens | The rules you hold it to |
|---|---|---|
| 0. Size-up, once | The incident is opened with its objective, constraints, priorities and working directory and nothing else; a cheap seat (Haiku) sizes it up and hands back an `IncidentBriefing`, which is checked and then seeds the record: its proposed questions under `briefing.questions`, its dominant problem as the picture, its unchecked needs as open items. | A diagnosis takes no fix objective, no fix unit and no intended-behavior question (the validator rejects them). Nothing in the briefing binds you. The proposed questions do not go to the human: on your first turn you accept each (you ask it, and the incident waits), discard it with a why, or answer it from the objective. |
| 1. Command turn | Your briefing is the change since your last turn (endings, each report with its slice picture and the work behind it, answers, refusals, cancellations) and the keys of `incident.json` that changed since that turn (the whole file on a fresh session). You write the `CommandTurn`: the period's objectives and priorities; a verdict on every unit whose report is listed; your situation; deterministic tasks under command if you need a fact; the incident status. It is checked, every reject fixed, then applied. | One verdict per reporting unit, on its last report: `accepted` (met on observed claims; the unit closes), `revise` (the same leader finishes; your instructions say what is missing, never what you think the answer is), or `reassign` (the unit closes, its open tasks are cancelled, and the next plan must create a unit that takes its instructions and its claims by reference, or you drop the slice with a why). `satisfied` needs the period objectives and the incident objective met on observed claims, with no task still open. |
| 2. Draft | A fresh planner seat, with `incident.json` and the validator in reach, hands back an `ActionPlan` it has already checked. | The rules in the checklist below. |
| 3. Check | You run the plan check yourself before you read the draft for substance. | A `REJECT` line goes back to the same planner verbatim as the reason, up to two redrafts; `WARN` lines are for your review; you do not read a rejected draft for substance. Every rejection is in the log. |
| 4. Review | You read the valid draft for substance: does it work your open items, does it serialize independent work, does it upgrade a model without a reason, does it state what you believe as a unit's objective. You answer with a `ReviewTurn`, which is checked and applied: the verdict is logged, a `correct`'s patches are applied to the draft mechanically, an `amend` replaces it, and the result is checked as a plan again. | `approve`; or `correct` as a list of patches (`set` a draft task's field, `add` a task, `cancel` a draft or open task), with no redraft and no second reading; or `amend` (you rewrite it). Never correct for a rule; the check has held the draft to every rule already. |
| 5. Apply | The approved plan is applied: units and tasks get ids; what the plan cancels is cancelled and, transitively, every pending task that depended on a failed or cancelled one, with the reason written; reassignments are marked taken. A leader session is launched for each new unit; it orients itself from the record and reports up when ready. | A unit whose ready work was all cancelled owes a report. |
| 6. Pass | The state machine (`incident_next.mjs`) says what is next: tasks to start now (independent ones together), leaders due a call and why, tasks held (a picture-changing report awaits a verdict, or the task's bound exceeds the remaining budget), tasks stale (running past twice their bound), units waiting on an answer, and what waits on you. A deterministic task you run and record. A session task goes to its unit's leader, which spawns it; its result is checked and recorded as it lands. A leader due a call gets its turn prompt; it checks and records its own `LeaderTurn` and marks what it was given as heard. Repeat until nothing is left to start or call. | The first report that changes the picture ends the pass; runs in flight finish and their endings are heard on the leader's next call. A refused call is retried once on the fallback model (Opus 4.8); a second refusal goes to judgment: a unit reports `not_met` with both refusals for you to decide; your own double refusal goes to the human as a question. A seat that returns no valid object after three corrections ends its task `failed`. |
| 7. Report | A leader reports when its objective is met, not met (with why and a suggestion) or in progress: the outcome, what changed on which claims, whether the picture changed, its own picture of its slice, and any resource request (permission, missing means, or something only a human knows). Recording it marks the unit's endings heard; a resource request becomes a question or a resource gap, puts the unit in `waiting` until answered, and makes the report picture-changing. | A report is the leader's account; the work beneath it (tasks, endings, claims, evidence) is what you judge it against. |
| 8. Repeat from 1 | Until you declare `satisfied` or `failed`, a question to the human blocks (recording the answer reopens the incident and releases a waiting unit), or the budget is spent. At the end, the After Action Review and the morning report are read from the record. | Every model call is in the record as a `call` event with its tokens, seconds and cost, logged by the hooks from the transcripts. |

## When a task ends: the state machine, and where judgment is spent

A leader is called only on a decision, and a task that could not be completed is a
decision.

| A task ends | What you update, mechanically | Whether the leader is called |
|---|---|---|
| `completed` | Its status; its claims with basis, confidence and what they cite; its evidence; the tasks that depended on it become ready and you start them. | No. The task session already judged its own completion against its completion criteria. The ending waits, one line, for the leader's next call. |
| `insufficient` (the session could not finish and names the kind of lack) or `failed` (the run died, was refused twice, or a command errored) | Its status and the reason; every pending task that depended on it is cancelled with the reason. | Yes, at once: the unit's plan for its slice has changed and the leader decides the next assignment or reports. |
| `completed`, and the leader flagged `consult` on this task when it assigned it | As `completed`. | Yes: the leader said in advance it wanted to judge this one. |
| `completed`, and the task session set `pictureChanged` on its result (what it found is not what its brief expected) | As `completed`. | Yes, at once: new information the unit did not plan for is a decision, and the leader re-plans its slice or reports that the picture changed. |
| The last ready task ends and a report is due | The unit's pass ends. | Yes: the leader reads every ending it has not yet seen, in one call, and judges whether the unit's objective is met on observed claims; it reports `met`, `not_met` or `progress`, or assigns more tasks instead. This is where a task's completion is judged in substance. |
| A report lands | The report and the unit's slice picture. | You judge it against the work beneath it: accepted, revise, reassign. |

The leader's judgment is batched at decisions rather than spent once per ending. A leader
that wants to judge a particular task the moment it completes flags `consult` on it; a task
that finds something its brief did not expect sets `pictureChanged` on its result and is
heard at once; the report call catches the rest.

## The checklist you apply to every draft and every turn

`incident_validator.mjs`, in the plugin's `scripts/` folder, applies every row as a tool call, and every
seat runs the mode for the object it is about to return, fixing what is rejected before
returning it:

| Mode | Checks | Run by |
|---|---|---|
| `node incident_validator.mjs plan incident.json draft.json [working-directory]` | A planner's `ActionPlan`. | The planner, before it returns the draft; you, before you read it for substance. |
| `node incident_validator.mjs command incident.json turn.json [working-directory]` | Your `CommandTurn`. | You, before you apply the turn. |
| `node incident_validator.mjs leader incident.json turn.json <unit-id>` | A leader's `LeaderTurn`: its report's shape and grounding, its assignments under its own unit, its `consult` names. | The leader, before it returns the turn. |
| `node incident_validator.mjs result incident.json result.json <task-id>` | A task session's result: the outcome, the findings, each claim's basis, confidence and citations against the evidence its brief attached. | The task session, before it returns the result. |
| `node incident_validator.mjs briefing incident.json briefing.json` | The size-up's `IncidentBriefing`: its fields, a checked need carrying its finding, and on a diagnosis no fix objective, no fix unit and no intended-behavior question. | The size-up subagent, before it returns the briefing; you, before you seed your picture from it. |
| `node incident_validator.mjs review incident.json review.json <draft.json>` | Your `ReviewTurn`: the verdict, patches only on `correct` and each addressing a task the draft has, a whole plan only on `amend` (checked as a plan). | You, before you apply a correction or an amendment. |
| `node incident_validator.mjs handoff incident.json handoff.json` | An outgoing IC's `HandoffDocument`: the period, every active unit listed, the hypothesis grounded on real claims, what was set aside with why, the next move. | You, before you hand command to a successor session. |
| `node incident_validator.mjs brief incident.json brief.json <kind> [id]` | A brief you send down, with `kind` one of `orientation` or `turn` (the unit id), `task` (the task id), `planner`, `sizeup`: the keys the down-flow table names are present; a turn prompt's unheard endings are the unit's own and carry what their status needs; a task brief attaches every claim and result its `evidenceFrom` names, whole; the planner's copy of `incident.json` is whole; and nothing below you carries your `situation`, `picture`, `assessment`, `hypothesis` or open items. It warns when a turn prompt calls the leader with nothing to decide. | You, before you send any brief. |

It prints one line per finding, `REJECT <rule>: <reason>` or `WARN <rule>: <reason>`, each
reason naming the task, field or id concerned and what would satisfy the rule, and exits 1
on any reject. A seat that has the script and `incident.json` in reach checks itself; a
reject that reaches you anyway goes back to that seat verbatim as the reason for its retry.
A warning is read at review. The table below is what the script checks, so the rules can be
read without running it.

| Rule | What it requires |
|---|---|
| Fields complete | Every task names its resource, inputs, expected output, completion criteria, evidence required, dependencies and the evidence it reads; every session task and unit leader names a provider and a model; a deterministic task names none. |
| Dependencies resolve | Every `dependsOn` names an open task or a ref in this plan; nothing depends on a failed, cancelled or completed task; a task naming another in `evidenceFrom` also depends on it or the rationale says why not. |
| Paths exist | Every path a deterministic task names resolves against the working directory to something that exists. |
| Own unit | A leader's assignments name its own unit and resources its unit holds. |
| Smallest model that fits | Every session task and every unit leader is on the smallest model its work needs; an Opus or Fable model on a task or a leader carries a `modelWhy`. A leader above Sonnet earns its price only by decomposing work onto cheaper tasks, and the arithmetic says when: Opus costs 2.5 times Sonnet and Fable 5 times, against half saved by moving a task from Sonnet to Haiku, so an Opus leader pays for itself where the unit's task spend is about three times its leader's, and a Fable leader about eight. Judge a `modelWhy` against that: a large leader over one or two tasks, or over tasks as large as itself, costs on both sides and buys nothing. |
| Independent work runs together | Units and tasks with no dependency between them are in the same period; a reading never waits behind a reproduce it does not need. |
| Open items are worked | Every open item of your situation is settled by a task in the plan (`settles`) or you deferred it with a why. |
| Reassignments taken | Every open reassignment is taken by a new unit that names it, or you dropped it with a why. |
| Closing is clean | No plan closes a unit with a running task, or one whose revise has not been delivered. |
| Span of control | Five direct children per unit as the target, seven at most. |
| Budget respected | Every task fits the incident's remaining budget; a session task carries a time bound. |
| Status is earned | `satisfied` is not declared while a task is open, and not on an unexamined inference. Observed claims are what prove a thing, so an objective settled by them needs no defence. Where the claim that answers the objective is inferred, you may still satisfy, and the turn that does says which claim carries it, at what confidence, and what would have made it observed — and files that as an open item rather than closing over it. An inference you have named and bounded is a finding; one you have not is a guess the record cannot tell apart from a fact. |
| Reports answered | Every unit whose report is in the window has exactly one verdict, on its last report. |
| Situation grounded | Every claim your situation names exists; a picture called proven rests on observed claims. |
| Proposals ruled | On the first turn, every question the briefing proposed is ruled on once. |
| Scoped to the kind | On a diagnosis (an objective that asks to determine, identify, explain or find), the briefing proposes no fix objective, no fix unit and no intended-behavior question. |
| Patch applies | A `correct` carries at least one patch; each `set` names a draft task by ref or `#N`, a field and a value; each `add` carries a whole proposal; each `cancel` names a draft task or an open task; an `amend` carries the whole plan. |
| Provenance on a result | An `answered` result carries findings (and `pictureChanged: true` when what it found is not what the brief expected) and an `insufficient` one names its kind of lack; every claim has a subject, a predicate, a basis of `observed` or `inferred`, a confidence in 0 to 1, and citations that are tasks; a citation not attached to the brief makes the claim `inferred`. |
| Brief complete | Every brief going down carries the keys the down-flow table names for its kind; a task brief attaches, whole, every claim and result the task's `evidenceFrom` names. |
| Observations flow up | No brief below you carries your situation, picture, assessment, hypothesis or open items; a revise's instructions say what is missing, never the answer. |

## The scripts: the runtime as tool calls

Nine scripts in the plugin's `scripts/` folder do what the TypeScript runtime's deterministic code did between model calls,
so the session never edits state by hand and never decides by memory what a rule can
decide. Node 18 or later, no dependencies; every one reads `incident.json` and the log beside it.

| Script | Does | Runs when |
|---|---|---|
| `incident_validator.mjs <mode> incident.json <object>.json …` | Checks an object against the rules: modes `plan`, `command`, `leader`, `result`, `briefing`, `review`, `handoff`, `brief`. Prints `REJECT` and `WARN` lines with reasons; exit 1 on a reject. | Before any object is returned by a seat or applied by you. |
| `incident_init.mjs <working-directory> --objective "…" [--constraint …] [--priority …] [--mode until_done\|cutoff] [--attended yes\|no]` | Opens an incident: the run folder `<incidentsDir>/<project>/<id>/` with `incident.json`, `run.json` (how the run is driven: mode, attended, cutoff, heartbeat) and `log.jsonl`; seeds `configs` from `~/.claude/noscope/configs.json`; registers the folder in `~/.claude/noscope/current.json`. | Once, at the start. |
| `incident_current.mjs [working-directory]` | The incident open in a directory (or a parent of it): folder, id, status, period, mode. | By the hooks and shell scripts. |
| `incident_apply.mjs <mode> incident.json …` | Applies a validated object to the state and appends the events to `log.jsonl`: `command`, `plan`, `assign`, `start`, `ending`, `report`, `heard`, `answer` (which also releases a unit waiting on it), `briefing` (the size-up seeds the situation), `call` (one model call, priced at list, with its tool calls by name), `handoff` (command transferred), `run` (one field of `run.json`), `review` (the IC's verdict logged; a `correct`'s patches applied to the draft, an `amend` written over it), `rejected` (a validator's REJECT lines logged), `config` (a unit's form saved for every later incident). Report recording raises resource requests and sets the unit `waiting`. Allocates ids, cascades cancellations, numbers open items, closes units on verdicts, records reassignments, marks tasks ready when their dependencies complete. | Every time something happens. |
| `incident_next.mjs incident.json` | Reads the state machine off the state: tasks to start (and together), leaders due a call with the reason, units done for the pass, what awaits you, what blocks (a question, an ended incident, a spent budget), tasks held (a picture change or the budget), tasks stale, units waiting. | At every step of a pass, and when unsure what is next. |
| `incident_brief.mjs <kind> incident.json …` | Assembles a brief in the shape the validator's `brief` mode checks: `sizeup`, `ic`, `planner`, `orientation`, `turn`, `task`, `review`. | Before each message to a seat. |
| `incident_evidence.mjs <resource> …` | Runs `grep`, `read`, `git_history` or `check_path` and prints `{output, measure}` for `incident_apply.mjs ending`. | For every deterministic task. |
| `incident_report.mjs incident.json` | The morning report as Markdown: outcome, what needs the human (open questions, a blocked or failed status, resource requests), the situation as last written, verdicts, transfers of command, and the After Action Review whole. | At the end of a run, and at every stop of an unattended one. |
| `incident_review.mjs incident.json` | The After Action Review from the state and log: periods with their verdicts and tasks, wall time beside summed seconds and the critical path, calls and cost when logged, verdicts by kind, revisions, reassignments, refusals, claims and evidence. | At the end, and any time you want the picture of the run so far. |

`incident_lib.mjs` is shared code; `state.example.json` is the state's shape. In the plugin,
hooks run these scripts at the moments a runtime would: a seat's returned object is validated
and applied when the seat stops, a brief is checked before it is sent, the record refuses hand
edits, and the IC's session is kept cycling while `incident_next.mjs` has work (the plugin
README lists them). `tests/scenario.sh` runs the whole loop against a scratch repository
through those hooks (a first turn, a grep under command, a plan with one unit and two tasks, a
result with two claims, an insufficient ending that calls the leader, a report, an accepting
turn, the review).

## What you keep, and where

The record lives in the incidents repository, a git repository under the configured
`incidentsDir` (`~/.claude/noscope/config.json`; default `~/Documents/Projects/noscope-plugin-incidents`),
one folder per project and one per incident under it (`<incidentsDir>/<project>/<id>/`), and
nothing is written into the repository the incident concerns; `~/.claude/noscope/current.json`
maps a working directory to its open incident's folder, which is how the hooks find it. The
folder holds two files kept from the first turn, `incident.json`, the state, which the scripts
update in place (every applied turn, every ending and every report changes the fields it
touches, and nothing else), and `log.jsonl`, which they only append to, beside `run.json` (how
the run is driven), every brief, draft, turn and result as a file, and at the end the After
Action Review and the morning report. The IC commits the folder at every command turn and
at the end, so a crash loses at most one period's files. Both are JSON so a
seat reads them as they are and the validator can check against them; nothing is turned
into prose. The After Action Review is read from them, so if it is not written it did not
happen. `scripts/state.example.json` shows the shape with one unit, two tasks and a
claim.

`incident.json` and the situation are different kinds of thing, and the difference is the
top loop's observe and orient steps: the file is what happened, the situation is what you
think about it.

| | `incident.json` | The situation |
|---|---|---|
| What it is | `incident.json`: everything recorded, as data: the objective and constraints, the period, budget, every claim and evidence entry, the units, tasks by status, reports, reassignments, questions, grants, configs, resources, and the situation as one key. | Your picture of what is going on: `picture`, `evidence` for and against by claim id, `open` items, `assessment`, `changed`. |
| Who writes it | You, field by field, as things happen: a task's ending, a report, an applied turn each change the entries they touch; you never rewrite it whole. | You, on every command turn, as one field of the `CommandTurn` object; the log carries it and the incident file's `situation` key holds it. |
| What it holds | Facts with provenance: what happened, what was claimed, with what basis, by whom. | Interpretation: what you believe those facts add up to, what is still unknown, and whether you are on track. |
| Who reads it | You and the planner, whole. A leader and a task never see it; their briefs are built from parts of the same record. | The planner, whole, since it drafts against your open items and your assessment. Nobody below you. |
| How it changes | Every event changes the entries it touches, in place. | Only your turn changes it; you never edit its words outside a turn, only number its open items when you apply one. |

A claim lives under `claims` with its basis; your judgment that it supports the picture
lives under `situation.evidence`, by that claim's id. When the two disagree, the file
is what happened, the situation is what you think, and the next report settles it.

| Record | Contents |
|---|---|
| `incident.json`, its keys | `incident` (id, objective, constraints, priorities, status, working directory, budget, spent); `period` (number, objectives, priorities); `briefing` (the size-up's proposed questions, for the first turn); `situation`; `units` (id, parent, type, objective, leader model, equipment, allowlist, status, last verdict, whether a revise is pending); `tasks` (id, unit, resource, objective, inputs, expected output, completion criteria, evidence required, dependencies, evidence read, what it settles, model, budget, status, and when it ended, its result); `claims`; `evidence` (task id, resource, inputs, a count); `reports` (each awaiting a verdict until it has one); `reassignments` (open, taken or dropped); `questions`; `configs`; `resources` (each with its kind — `equipment`, which runs in process, or `personnel`, a session that judges — and which inputs are paths). |
| Your situation | `picture` (what the incident now believes, in prose), `evidence` (claims for and against, by id), `open` (what is not yet known, each with what would settle it; give each an id when you apply the turn), `assessment` (`on_track`, `priors_updated` or `tactics_change`, with a why; `tactics_change` tells the planner to redraw the units rather than extend them), `changed`. |
| A claim | Subject, predicate, object; basis `observed` or `inferred`; confidence 0 to 1; provenance (the task and session that asserted it, and the evidence it cites). A claim citing attached evidence keeps its basis; one citing nothing attached is `inferred`. Only a session asserts claims; you never turn a command's output into one. |
| Evidence | A deterministic task's output, kept whole under its task id, attached to a session's brief when the task names it, shown everywhere else as a count with the id. |
| `log.jsonl`, one object per event | Every call (seat, model, session id, tokens in and out, seconds, cost, what it returned); every unit opened or closed; every task created, started, completed, failed or cancelled (with what cancelled it); every report, verdict, plan drafted, rejected or applied; every question asked and answered; every refusal and fallback; every budget stop. Each with a timestamp and who wrote it; the scripts write all of these, the `call` events through `incident_apply.mjs call` once per model call, priced at list rates from the table in `incident_lib.mjs`; in the plugin, hooks log them from the transcripts (an agent seat's when it stops, the IC's and a leader's at the end of each turn). |
| The After Action Review, at the end | Every period with its calls and cost; cost per seat and per model; wall time per period beside the tasks' summed seconds and the period's critical path; verdicts by kind; revisions and reassignments with what each cost and found; refusals; claims and evidence counts. |

## Rules that stand whatever the incident

| Rule | Detail |
|---|---|
| Every seat has the approved tools | A subagent uses whatever tools this session's settings allow; the protocol adds no restriction of its own. |
| Provenance on everything | Every claim carries how it was checked; a session that cannot check says `inferred`; a report rests on observed claims or it is not `met`. |
| A model call is a decision | If a rule can decide it, you decide it by the rule; a model is called for judgment. So no call to a leader just to continue, no reading of a draft before it passes the checklist, and no leader doing a task itself. |
| Smallest model that fits | The three seats above a task run on configured models (`icModel`, `leaderModel`, `plannerModel` in `~/.claude/noscope/config.json`, copied onto `run.json` when a run starts), each a model id or `smallest`. Defaults: you on Sonnet 5, every unit leader on Sonnet 5 (which directs and judges well enough when its orientation and turn prompts are specific, and that specificity is the scripts' job), the planner on Opus 5 (it decomposes to tasks and assigns resources, which needs the task understood). `smallest` means the model judged right-sized for that role for this incident: the size-up names one for each seat (`incomingCommander`, `seatModels.planner`, `seatModels.leader`) from the available models with a why, and applying the briefing records it on `run.json` for every seat configured `smallest`; a fixed configuration is recorded and not followed. Every task is on the smallest model its kind of work needs: recording, reproducing and reading on Haiku or Sonnet, and Opus only for weighing evidence to a conclusion, with a why. |
| You file no report | You judge the results of your own deterministic tasks at your command turn; nobody reports to you about them. |
| The record is the truth | Every briefing you send a seat is built from `incident.json` and `log.jsonl` by the scripts, never from memory, so nothing is passed that is not recorded; a subagent or teammate that dies is redone from the record, never assumed. |
| No memory across incidents | The After Action Review is what a person carries forward; a new incident starts from its objective. |

## Formats: what each seat hands over, field by field

Every structured answer below is one JSON object you ask the seat to return (one object, not a union: the API refuses a top-level oneOf). The field descriptions are the ones the TypeScript runtime sends its models, verbatim, from its `src/models.ts` and the resource registry on the `rounds-4-5` branch at f009208 (2026-09-16); where they say "the runtime" or "the validator", read "you". Ask each seat for exactly this object and check the required fields yourself.

### The briefing (initial IC to IC): `IncidentBriefing`

- `kind` (string, required): What sort of incident this is, in a few words, read from the objective's verb: determine, identify, explain or find, or a question (where, what, why), is a diagnosis (a bug hunt, a question about a codebase); build, change, fix or add is a build (a feature, a migration)
- `dominantProblem` (string, required): The one problem the incident turns on, one paragraph
- `obviouslyNeeded` (array of objects, required): What the incident obviously needs: access, equipment, facts, permissions; each checked where a tool could check it
  - `what` (string, required)
  - `checked` (boolean, required): Whether a tool checked it during the size-up
  - `finding` (string, optional): With checked: which tool checked it and what it showed
- `initialObjectives` (array of string, required): Objectives for the first operational period, as you see them, scoped to the objective's verb: a diagnosis (determine, identify, explain, find, or a question: where, what, why) takes no fix objective, since the answer is the cause; a build (build, change, fix, add) takes one
- `initialOrganization` (array of string, required): Units sketched, one line each: what the unit is for and what model its leader should be on; no fix unit on a diagnosis
- `questionsForHuman` (array of string, required): Questions for the human you propose to the Incident Commander, who accepts each (it is asked, and the incident waits on their answer), discards it with a why, or answers it from the objective: only what only they know or may decide, that no tool could find and the objective does not already settle; on a diagnosis, no question about what the intended behavior should be
- `hazards` (array of string, required): What could go wrong or mislead: a stale document, a writing command, an ambiguous objective
- `incomingCommander` (object, required)
  - `provider` (string, required)
  - `model` (string, required): A model the provider serves
  - `why` (string, required): Why this model for this incident: what the judgment it needs is
- `seatModels` (object, optional; a plugin addition): the model right-sized for this incident for the other seats above a task, each `model` and `why`; taken for a seat the human configured as `smallest`
  - `planner` (object, optional)
  - `leader` (object, optional)

### The command turn (you, each period): `CommandTurn`

The first turn of an incident is `FirstCommandTurn`, the same object with `briefingEvaluation` and `briefingQuestions` required.

- `briefingEvaluation` (array of objects, optional): On the first turn after a transfer of command: each initial objective and each unit sketched in the briefing, accepted, rewritten or discarded, and why
  - `item` (string, required): The briefing item, as the briefing states it
  - `verdict` (one of `accepted`, `rewritten`, `discarded`, required)
  - `why` (string, required)
- `briefingQuestions` (array of objects, optional): On the first turn after the initial IC's briefing: a ruling on each question it proposed for the human, by number: accept (it is asked, and the incident waits on their answer), discard with why, or answer it from the objective with the answer; a question you would ask differently is discarded here and raised in questionsForHuman; empty when the briefing proposed none or you took command by handoff
  - `proposal` (integer, required): The question's number in the briefing, as the transfer of command lists it
  - `verdict` (one of `accept`, `discard`, `answer`, required)
  - `why` (string, required): For accept: why only the human can answer it; for discard: why the incident does not need it; for answer: where the answer comes from (the objective, a constraint, the file)
  - `answer` (string, optional): With verdict answer: the answer, recorded as the IC's
- `periodObjectives` (array of string, required): The objectives for this operational period, from the incident objective, the constraints, the priorities and the units' reports
- `priorities` (array of string, required): The incident's priorities, restated or revised for this period
- `reportVerdicts` (array of objects, required): One verdict per unit that reported, naming the unit and the event id of its last report the change report lists (an earlier report of the same unit is marked as answered through the last and takes none): accepted, revise or reassign, with instructions for the last two and a why for each
  - `reportId` (string, required): The report's event id, as the change report heads it
  - `unitId` (string, required): The unit that reported
  - `verdict` (one of `accepted`, `revise`, `reassign`, required)
  - `instructions` (string, required): For revise: what is missing, for the same leader to finish; for reassign: what the unit found and did not find, for the unit that takes its slice; empty for accepted. Never what you think the answer is: a unit reads its objective and the evidence, not your picture
  - `why` (string, required): Why this verdict, from the work shown; it reaches the unit's leader with the instructions, so it says what the work showed and never what you think the answer is
- `situation` (object, required): The situation: the picture of reality the incident holds, edited from the one the incident file shows you (seeded from the briefing on your first turn), the claims for and against it by id, what is not yet known with what would settle it, your assessment (on_track, priors_updated or tactics_change) with why, and what this turn changed; the planner reads it in full and no unit ever does. A reassignment updates the slice it concerns
  - `picture` (string, required): What the incident now believes is going on, one paragraph: edit the picture you were given, do not restate it
  - `evidence` (array of objects, required): The claims that support or contradict the picture, by id, each marked for or against; only a claim marked for with basis observed proves any part of the picture
    - `claimId` (string, required)
    - `stance` (one of `for`, `against`, required): Whether the claim supports the picture or contradicts it
  - `open` (array of objects, required): What is not yet known, each with what would settle it; every item is worked by a task in the period's plan or deferred here with why
    - `id` (string, optional): Only for an item carried forward from your last picture: its id as the file lists it. Leave it out for a new item; the runtime numbers it. Never write an id the file does not list
    - `what` (string, required): What is not yet known, one line
    - `settledBy` (string, required): What would settle it, in prose: what must be read, run or reproduced; the plan's task that works it names this item's id in settles
    - `deferred` (string, optional): Why this item is not worked this period: a decision recorded, not an omission; an item neither worked by a task nor deferred rejects the plan
  - `assessment` (object, required): Where the incident stands after this turn: on_track, priors_updated, or tactics_change when the units must be redrawn rather than extended
    - `kind` (one of `on_track`, `priors_updated`, `tactics_change`, required)
    - `why` (string, required): Why, one sentence
  - `changed` (string, required): What this turn changed in the picture, one paragraph; on the first turn, what you made of the briefing's seed
- `closeUnits` (array of objects, required): Units to close that did not report this period; a reported unit is closed by accepting or reassigning its report, never here
  - `unitId` (string, required)
  - `reason` (string, required)
- `dropReassignments` (array of objects, optional): Open reassignments to drop rather than have a plan take: each closes on this turn and no unit takes it
  - `id` (string, required): An open reassignment's id, as the incident file lists it under your situation
  - `why` (string, required)
- `answers` (array of objects, optional): The resource requests listed in the change report, each answered; nothing else goes here
  - `unitId` (string, required): The unit that raised the request
  - `request` (string, required): The request, as the unit stated it
  - `answer` (string, required)
- `assignTasks` (array of objects, optional): Deterministic tasks to run under command this cycle (grep, read, check_path, git_history: no provider, no model), each naming the root unit as its unit; they run in this cycle's pass, and one that dependsOn a unit's task runs in the pass after that task completes, since the root runs first in each pass; their results open your next change report. Session work is a unit's: a task to a session-backed resource is refused here and belongs in a period objective for the planner to place under a unit
  - `ref` (string, optional): A label another task in this plan can name in dependsOn, so a chain of tasks runs in one cycle
  - `unit` (string, required): An existing unit id, or the ref of a unit created in this plan
  - `resource` (string, required)
  - `objective` (string, required)
  - `inputs` (object, required)
  - `expectedOutput` (string, required)
  - `completionCriteria` (array of string, required)
  - `evidenceRequired` (array of string, required)
  - `dependsOn` (array of string, required): Task ids, or refs of tasks created in this plan
  - `evidenceFrom` (object, optional): Claims by id and tasks by id or ref whose content this task needs; the runtime attaches them, so do not copy evidence into inputs
    - `claims` (array of string, optional)
    - `tasks` (array of string, optional)
  - `scope` (string, required): One line naming the territory this task owns, written so a
    sibling task can tell whose work is whose: the files, the surface or the question it covers.
    Every other task of the same unit is shown this line and told to stay out of it, so write what
    it covers and never what you expect it to find — a scope that leaks the picture makes a seat
    test your hypothesis instead of the evidence.
  - `settles` (array of string, optional): The open items of the IC's situation this task settles, by id as the incident file's situation lists them; every open item the IC did not defer is named here by some task
  - `instructions` (string, required)
  - `provider` (string or null, required)
  - `model` (string or null, required)
  - `modelWhy` (string, optional): Why this task's model is larger than its kind of work needs: required in substance when the model is an Opus or Fable one, since recording, reproducing and reading are Haiku or Sonnet work and only weighing evidence to a conclusion may take Opus; omit it on a smaller model
  - `budget` (object, required)
    - `tokens` (integer, optional)
    - `seconds` (number, optional)
  - `strikeTeam` (array of objects, optional): The subagent kinds the session running this task may send, each with its model, tools, prompt, count and why; more than one kind is a task force. No kind exists unless declared here, by whoever defines the task
    - `kind` (string, required): The kind's name, as the session names it when it sends a member: letters, digits, - and _
    - `model` (string, required): A model the task's provider serves
    - `tools` (array of string, required): Built-in tool names a member may use: Read, Grep, Glob, Bash (under the session's read-only allowlist); nothing that writes
    - `prompt` (string, required): The member's system prompt
    - `count` (integer, required): How many members the leader intends to send
    - `why` (string, required): Why this team, this shape and this count
- `questionsForHuman` (array of string, required)
- `resourceGaps` (array of objects, required)
  - `need` (string, required)
  - `why` (string, required)
- `grantRequests` (array of objects, required)
  - `resource` (string, required)
  - `effect` (one of `read_only`, `writes_local`, `writes_external`, required)
  - `reason` (string, required)
- `incidentStatus` (one of `continue`, `blocked`, `satisfied`, `failed`, required)
- `rationale` (string, required): Why these objectives and this status, one paragraph
- `discrepancy` (string, optional): Only when the update received describes a different problem from the one being worked, not a different detail: what differs

### The situation (part of the command turn; the planner reads it whole, a unit never does): `Situation`

- `picture` (string, required): What the incident now believes is going on, one paragraph: edit the picture you were given, do not restate it
- `evidence` (array of objects, required): The claims that support or contradict the picture, by id, each marked for or against; only a claim marked for with basis observed proves any part of the picture
  - `claimId` (string, required)
  - `stance` (one of `for`, `against`, required): Whether the claim supports the picture or contradicts it
- `open` (array of objects, required): What is not yet known, each with what would settle it; every item is worked by a task in the period's plan or deferred here with why
  - `id` (string, optional): Only for an item carried forward from your last picture: its id as the file lists it. Leave it out for a new item; the runtime numbers it. Never write an id the file does not list
  - `what` (string, required): What is not yet known, one line
  - `settledBy` (string, required): What would settle it, in prose: what must be read, run or reproduced; the plan's task that works it names this item's id in settles
  - `deferred` (string, optional): Why this item is not worked this period: a decision recorded, not an omission; an item neither worked by a task nor deferred rejects the plan
- `assessment` (object, required): Where the incident stands after this turn: on_track, priors_updated, or tactics_change when the units must be redrawn rather than extended
  - `kind` (one of `on_track`, `priors_updated`, `tactics_change`, required)
  - `why` (string, required): Why, one sentence
- `changed` (string, required): What this turn changed in the picture, one paragraph; on the first turn, what you made of the briefing's seed

### The action plan (planner to you): `ActionPlan`

- `createUnits` (array of objects, required)
  - `objective` (string, required): What the unit is to establish; its leader reports against it, and the IC judges the report
  - `scope` (string, required): One line naming the territory this unit covers, written so another unit can tell
    whose ground is whose: the area, the surface or the question it owns. Every other unit is shown this line, and so
    is the IC, so write what it covers and never what you expect it to find. Decide it deliberately when you place the
    unit: two units whose scopes overlap do the same work twice and neither reports the gap between them
  - `leader` (object, optional): The provider and model of the unit's leader session, which directs the unit's tasks, runs none of them and holds no tools, and reports against its objective
    - `provider` (string, required)
    - `model` (string, required)
  - `equipment` (array of string, optional): Built-in tool names and external equipment names the unit's tasks may use; a session task under the unit needs no more than this, and every session task runs in a session of its own
  - `bashAllowlist` (array of string, optional): Commands the unit's tasks' read-only Bash may run
  - `role` (string, optional): The role text the leader's session reads in place of the type's own; omit it for the type's
  - `config` (string, optional): The name of a saved unit config (section 8 lists them) whose leader, equipment, bashAllowlist and role fill this unit's form; give only objective and parent beside it, or a field to override the config's
  - `ref` (string, required): A label the plan uses to refer to this new unit elsewhere
  - `parent` (string, required): An existing unit id, or the ref of a unit created in this plan
  - `type` (string, optional): The unit's type, whose form these fields fill and whose protocol runs it: base, the led unit, is the only type a plan may create
  - `takes` (string, optional): The id of an open reassignment this unit takes: the slice of a unit the IC closed with a reassign verdict, whose instructions and claims the new unit's leader is oriented with; every open reassignment is taken by exactly one new unit
  - `modelWhy` (string, optional): Why the leader's model is larger than its work needs: required in substance when the leader is on an Opus or Fable model, since directing narrow tasks is Haiku or Sonnet work; omit it on a smaller model
- `closeUnits` (array of objects, required)
  - `unitId` (string, required)
  - `reason` (string, required)
- `createTasks` (array of objects, required)
  - `ref` (string, optional): A label another task in this plan can name in dependsOn, so a chain of tasks runs in one cycle
  - `unit` (string, required): An existing unit id, or the ref of a unit created in this plan
  - `resource` (string, required)
  - `objective` (string, required)
  - `inputs` (object, required)
  - `expectedOutput` (string, required)
  - `completionCriteria` (array of string, required)
  - `evidenceRequired` (array of string, required)
  - `dependsOn` (array of string, required): Task ids, or refs of tasks created in this plan
  - `evidenceFrom` (object, optional): Claims by id and tasks by id or ref whose content this task needs; the runtime attaches them, so do not copy evidence into inputs
    - `claims` (array of string, optional)
    - `tasks` (array of string, optional)
  - `scope` (string, required): One line naming the territory this task owns, written so a
    sibling task can tell whose work is whose: the files, the surface or the question it covers.
    Every other task of the same unit is shown this line and told to stay out of it, so write what
    it covers and never what you expect it to find — a scope that leaks the picture makes a seat
    test your hypothesis instead of the evidence.
  - `settles` (array of string, optional): The open items of the IC's situation this task settles, by id as the incident file's situation lists them; every open item the IC did not defer is named here by some task
  - `instructions` (string, required)
  - `provider` (string or null, required)
  - `model` (string or null, required)
  - `modelWhy` (string, optional): Why this task's model is larger than its kind of work needs: required in substance when the model is an Opus or Fable one, since recording, reproducing and reading are Haiku or Sonnet work and only weighing evidence to a conclusion may take Opus; omit it on a smaller model
  - `budget` (object, required)
    - `tokens` (integer, optional)
    - `seconds` (number, optional)
  - `strikeTeam` (array of objects, optional): The subagent kinds the session running this task may send, each with its model, tools, prompt, count and why; more than one kind is a task force. No kind exists unless declared here, by whoever defines the task
    - `kind` (string, required): The kind's name, as the session names it when it sends a member: letters, digits, - and _
    - `model` (string, required): A model the task's provider serves
    - `tools` (array of string, required): Built-in tool names a member may use: Read, Grep, Glob, Bash (under the session's read-only allowlist); nothing that writes
    - `prompt` (string, required): The member's system prompt
    - `count` (integer, required): How many members the leader intends to send
    - `why` (string, required): Why this team, this shape and this count
- `cancelTasks` (array of string, required)
- `questionsForHuman` (array of string, required)
- `grantRequests` (array of objects, required)
  - `resource` (string, required)
  - `effect` (one of `read_only`, `writes_local`, `writes_external`, required)
  - `reason` (string, required)
- `resourceGaps` (array of objects, required): What the planner needs and why; the answer is the human's, through incident provide
  - `need` (string, required)
  - `why` (string, required)
- `applySops` (array of objects, required)
  - `sop` (string, required)
  - `parent` (string, required)
  - `angles` (array of string, required)
- `incidentStatus` (one of `continue`, `blocked`, `satisfied`, `failed`, required)
- `rationale` (string, required): Why this plan, one paragraph: how it works the open items of the IC's situation, and the priority that chose between plans
- `discrepancy` (string, optional): Only when the update received describes a different problem from the one being worked, not a different detail: what differs

### The review (you, on a valid draft): `ReviewTurn`

- `verdict` (one of `approve`, `correct`, `amend`, required)
- `patches` (array of objects, optional): With verdict correct: the edits, each one task's field, a task to add or a task to cancel; the runtime applies them to the draft, and the plan is not reviewed again
  - `kind` (one of `set`, `add`, `cancel`, required): set replaces one field of a draft task; add appends a task to createTasks; cancel removes a draft task, or adds an open task's id to cancelTasks
  - `task` (string, optional): With set or cancel: the draft task's ref, or #N for the Nth task of createTasks as the draft lists them; with cancel, an open task's id instead
  - `field` (one of `ref`, `unit`, `resource`, `objective`, `inputs`, `expectedOutput`, `completionCriteria`, `evidenceRequired`, `dependsOn`, `evidenceFrom`, `instructions`, `scope`, `provider`, `model`, `budget`, `strikeTeam`, optional): With set: the task's field to replace
  - `value` (value, optional): With set: the field's new value, whole, in the field's own shape (dependsOn is a list of refs or ids, model a string, budget an object)
  - `proposal` (object, optional): With add: the task to add, whole, as the planner would have drafted it
    - `ref` (string, optional): A label another task in this plan can name in dependsOn, so a chain of tasks runs in one cycle
    - `unit` (string, required): An existing unit id, or the ref of a unit created in this plan
    - `resource` (string, required)
    - `objective` (string, required)
    - `inputs` (object, required)
    - `expectedOutput` (string, required)
    - `completionCriteria` (array of string, required)
    - `evidenceRequired` (array of string, required)
    - `dependsOn` (array of string, required): Task ids, or refs of tasks created in this plan
    - `evidenceFrom` (object, optional): Claims by id and tasks by id or ref whose content this task needs; the runtime attaches them, so do not copy evidence into inputs
      - `claims` (array of string, optional)
      - `tasks` (array of string, optional)
  - `scope` (string, required): One line naming the territory this task owns, written so a
    sibling task can tell whose work is whose: the files, the surface or the question it covers.
    Every other task of the same unit is shown this line and told to stay out of it, so write what
    it covers and never what you expect it to find — a scope that leaks the picture makes a seat
    test your hypothesis instead of the evidence.
    - `settles` (array of string, optional): The open items of the IC's situation this task settles, by id as the incident file's situation lists them; every open item the IC did not defer is named here by some task
    - `instructions` (string, required)
    - `provider` (string or null, required)
    - `model` (string or null, required)
    - `modelWhy` (string, optional): Why this task's model is larger than its kind of work needs: required in substance when the model is an Opus or Fable one, since recording, reproducing and reading are Haiku or Sonnet work and only weighing evidence to a conclusion may take Opus; omit it on a smaller model
    - `budget` (object, required)
      - `tokens` (integer, optional)
      - `seconds` (number, optional)
    - `strikeTeam` (array of objects, optional): The subagent kinds the session running this task may send, each with its model, tools, prompt, count and why; more than one kind is a task force. No kind exists unless declared here, by whoever defines the task
      - `kind` (string, required): The kind's name, as the session names it when it sends a member: letters, digits, - and _
      - `model` (string, required): A model the task's provider serves
      - `tools` (array of string, required): Built-in tool names a member may use: Read, Grep, Glob, Bash (under the session's read-only allowlist); nothing that writes
      - `prompt` (string, required): The member's system prompt
      - `count` (integer, required): How many members the leader intends to send
      - `why` (string, required): Why this team, this shape and this count
  - `why` (string, required): Why this edit, one sentence
- `plan` (object, optional): With verdict amend: the whole plan as amended, which is applied in place of the draft
  - `createUnits` (array of objects, required)
    - `objective` (string, required): What the unit is to establish; its leader reports against it, and the IC judges the report
  - `scope` (string, required): One line naming the territory this unit covers, written so another unit can tell
    whose ground is whose: the area, the surface or the question it owns. Every other unit is shown this line, and so
    is the IC, so write what it covers and never what you expect it to find. Decide it deliberately when you place the
    unit: two units whose scopes overlap do the same work twice and neither reports the gap between them
    - `leader` (object, optional): The provider and model of the unit's leader session, which directs the unit's tasks, runs none of them and holds no tools, and reports against its objective
      - `provider` (string, required)
      - `model` (string, required)
    - `equipment` (array of string, optional): Built-in tool names and external equipment names the unit's tasks may use; a session task under the unit needs no more than this, and every session task runs in a session of its own
    - `bashAllowlist` (array of string, optional): Commands the unit's tasks' read-only Bash may run
    - `role` (string, optional): The role text the leader's session reads in place of the type's own; omit it for the type's
    - `config` (string, optional): The name of a saved unit config (section 8 lists them) whose leader, equipment, bashAllowlist and role fill this unit's form; give only objective and parent beside it, or a field to override the config's
    - `ref` (string, required): A label the plan uses to refer to this new unit elsewhere
    - `parent` (string, required): An existing unit id, or the ref of a unit created in this plan
    - `type` (string, optional): The unit's type, whose form these fields fill and whose protocol runs it: base, the led unit, is the only type a plan may create
    - `takes` (string, optional): The id of an open reassignment this unit takes: the slice of a unit the IC closed with a reassign verdict, whose instructions and claims the new unit's leader is oriented with; every open reassignment is taken by exactly one new unit
    - `modelWhy` (string, optional): Why the leader's model is larger than its work needs: required in substance when the leader is on an Opus or Fable model, since directing narrow tasks is Haiku or Sonnet work; omit it on a smaller model
  - `closeUnits` (array of objects, required)
    - `unitId` (string, required)
    - `reason` (string, required)
  - `createTasks` (array of objects, required)
    - `ref` (string, optional): A label another task in this plan can name in dependsOn, so a chain of tasks runs in one cycle
    - `unit` (string, required): An existing unit id, or the ref of a unit created in this plan
    - `resource` (string, required)
    - `objective` (string, required)
    - `inputs` (object, required)
    - `expectedOutput` (string, required)
    - `completionCriteria` (array of string, required)
    - `evidenceRequired` (array of string, required)
    - `dependsOn` (array of string, required): Task ids, or refs of tasks created in this plan
    - `evidenceFrom` (object, optional): Claims by id and tasks by id or ref whose content this task needs; the runtime attaches them, so do not copy evidence into inputs
      - `claims` (array of string, optional)
      - `tasks` (array of string, optional)
  - `scope` (string, required): One line naming the territory this task owns, written so a
    sibling task can tell whose work is whose: the files, the surface or the question it covers.
    Every other task of the same unit is shown this line and told to stay out of it, so write what
    it covers and never what you expect it to find — a scope that leaks the picture makes a seat
    test your hypothesis instead of the evidence.
    - `settles` (array of string, optional): The open items of the IC's situation this task settles, by id as the incident file's situation lists them; every open item the IC did not defer is named here by some task
    - `instructions` (string, required)
    - `provider` (string or null, required)
    - `model` (string or null, required)
    - `modelWhy` (string, optional): Why this task's model is larger than its kind of work needs: required in substance when the model is an Opus or Fable one, since recording, reproducing and reading are Haiku or Sonnet work and only weighing evidence to a conclusion may take Opus; omit it on a smaller model
    - `budget` (object, required)
      - `tokens` (integer, optional)
      - `seconds` (number, optional)
    - `strikeTeam` (array of objects, optional): The subagent kinds the session running this task may send, each with its model, tools, prompt, count and why; more than one kind is a task force. No kind exists unless declared here, by whoever defines the task
      - `kind` (string, required): The kind's name, as the session names it when it sends a member: letters, digits, - and _
      - `model` (string, required): A model the task's provider serves
      - `tools` (array of string, required): Built-in tool names a member may use: Read, Grep, Glob, Bash (under the session's read-only allowlist); nothing that writes
      - `prompt` (string, required): The member's system prompt
      - `count` (integer, required): How many members the leader intends to send
      - `why` (string, required): Why this team, this shape and this count
  - `cancelTasks` (array of string, required)
  - `questionsForHuman` (array of string, required)
  - `grantRequests` (array of objects, required)
    - `resource` (string, required)
    - `effect` (one of `read_only`, `writes_local`, `writes_external`, required)
    - `reason` (string, required)
  - `resourceGaps` (array of objects, required): What the planner needs and why; the answer is the human's, through incident provide
    - `need` (string, required)
    - `why` (string, required)
  - `applySops` (array of objects, required)
    - `sop` (string, required)
    - `parent` (string, required)
    - `angles` (array of string, required)
  - `incidentStatus` (one of `continue`, `blocked`, `satisfied`, `failed`, required)
  - `rationale` (string, required): Why this plan, one paragraph: how it works the open items of the IC's situation, and the priority that chose between plans
  - `discrepancy` (string, optional): Only when the update received describes a different problem from the one being worked, not a different detail: what differs
- `rationale` (string, required): Why this verdict, one paragraph
- `discrepancy` (string, optional): Only when the update received describes a different problem from the one being worked, not a different detail: what differs
- `briefingEvaluation` (array of objects, optional): Only on a review that is this session's first call after a transfer of command (a handoff before the review): each item of the handoff document, accepted, rewritten or discarded, and why
  - `item` (string, required): The briefing item, as the briefing states it
  - `verdict` (one of `accepted`, `rewritten`, `discarded`, required)
  - `why` (string, required)

### The leader turn (unit leader to you, when called): `LeaderTurn`

- `kind` (one of `report`, `continue`, required)
- `report` (object or null, required): The report on a report turn; null on a continue turn
  - `outcome` (one of `met`, `not_met`, `progress`, required)
  - `changed` (array of objects, required): What is now true that was not, each citing the claims it rests on
    - `what` (string, required): One thing that is now true that was not, in one line
    - `claims` (array of string, required): Claim ids the change rests on
  - `pictureChanged` (boolean, required): Whether what the unit found changes the picture the incident is working from, so the IC should act before anything new starts
  - `situation` (object, required): Your unit's picture of its slice: what it now believes, the claims for and against by id, what it does not yet know with what would settle it, and what changed since its last report; the IC folds it into the incident's picture
    - `picture` (string, required): What your unit now believes about its slice of the problem, one paragraph
    - `evidence` (array of objects, required): Your unit's claims that support or contradict its picture, by id, each marked for or against
      - `claimId` (string, required)
      - `stance` (one of `for`, `against`, required): Whether the claim supports the picture or contradicts it
    - `open` (array of objects, required): What your unit does not yet know about its slice, each with what would settle it
      - `what` (string, required): What is not yet known, one line
      - `settledBy` (string, required): What would settle it, in prose: what must be read, run or reproduced; the plan's task that works it names this item's id in settles
    - `changed` (string, required): What changed in your unit's picture since its last report
  - `why` (string, optional): When the objective is not met: why
  - `suggestion` (string, optional): When the objective is not met: what to do about it
  - `resourceRequests` (array of objects, optional): What you lack and cannot get inside your unit: permission, missing means, or something only a human knows; never a retrievable fact, which you assign a task for. Any request puts your unit in waiting until the IC or the human answers, and the report counts as picture-changing
    - `kind` (one of `permission`, `missing_means`, `human_knowledge`, required)
    - `what` (string, required): What is lacked, in one line
    - `why` (string, required): Why the unit's objective needs it
- `assignTasks` (array of objects, optional): Tasks to assign under your own unit, to resources your unit holds, inside your unit's budget: how you get a retrievable fact yourself, without waiting for the next plan. Each names your unit id as its unit and runs in a session of its own or in process; a strike team for one of them goes in that task's own strikeTeam field. They are checked by the validator's rules and run in this pass on a continue, next pass on a report
  - `ref` (string, optional): A label another task in this plan can name in dependsOn, so a chain of tasks runs in one cycle
  - `unit` (string, required): An existing unit id, or the ref of a unit created in this plan
  - `resource` (string, required)
  - `objective` (string, required)
  - `inputs` (object, required)
  - `expectedOutput` (string, required)
  - `completionCriteria` (array of string, required)
  - `evidenceRequired` (array of string, required)
  - `dependsOn` (array of string, required): Task ids, or refs of tasks created in this plan
  - `evidenceFrom` (object, optional): Claims by id and tasks by id or ref whose content this task needs; the runtime attaches them, so do not copy evidence into inputs
    - `claims` (array of string, optional)
    - `tasks` (array of string, optional)
  - `instructions` (string, required)
  - `provider` (string or null, required)
  - `model` (string or null, required)
  - `modelWhy` (string, optional): Why this task's model is larger than its kind of work needs: required in substance when the model is an Opus or Fable one, since recording, reproducing and reading are Haiku or Sonnet work and only weighing evidence to a conclusion may take Opus; omit it on a smaller model
  - `budget` (object, required)
    - `tokens` (integer, optional)
    - `seconds` (number, optional)
  - `strikeTeam` (array of objects, optional): The subagent kinds the session running this task may send, each with its model, tools, prompt, count and why; more than one kind is a task force. No kind exists unless declared here, by whoever defines the task
    - `kind` (string, required): The kind's name, as the session names it when it sends a member: letters, digits, - and _
    - `model` (string, required): A model the task's provider serves
    - `tools` (array of string, required): Built-in tool names a member may use: Read, Grep, Glob, Bash (under the session's read-only allowlist); nothing that writes
    - `prompt` (string, required): The member's system prompt
    - `count` (integer, required): How many members the leader intends to send
    - `why` (string, required): Why this team, this shape and this count
- `consult` (array of string, optional): Task ids of your unit, or refs of tasks in assignTasks on this turn, whose ending you want to be called on however it ends. A completed task you have not named here starts what depends on it without you and reaches you on your next turn; a failed or insufficient one calls you regardless. Name a task once; the flag holds until it ends
- `discrepancy` (string, optional): Only when the update received describes a different problem from the one being worked, not a different detail: what differs

### The unit's slice picture (part of a report; flows up to the IC): `UnitSituation`

- `picture` (string, required): What your unit now believes about its slice of the problem, one paragraph
- `evidence` (array of objects, required): Your unit's claims that support or contradict its picture, by id, each marked for or against
  - `claimId` (string, required)
  - `stance` (one of `for`, `against`, required): Whether the claim supports the picture or contradicts it
- `open` (array of objects, required): What your unit does not yet know about its slice, each with what would settle it
  - `what` (string, required): What is not yet known, one line
  - `settledBy` (string, required): What would settle it, in prose: what must be read, run or reproduced; the plan's task that works it names this item's id in settles
- `changed` (string, required): What changed in your unit's picture since its last report

### What the record keeps of a task

A seat returns its result whole and the runtime writes that object to a file in the run folder.
What `incident.json` keeps is a line: for a session task the outcome, one summary and the path
to that file; for an equipment task the measure and the path. The body stays in the file, and in
the seat's own transcript.

The reason is cost, not tidiness. A task's claims are extracted into `claims` when it ends, so
the body has already given up what the record reasons from, and everything handed the planner
carries the whole state — one file read kept 141K of file content in `incident.json` and sent it
again every period afterwards. A brief that attaches a task's evidence still attaches it whole:
`incident_brief.mjs` reads the body from the file.

### A task session's result (`investigate`): the resource's output

- `outcome` (one of `answered`, `insufficient`, required)
- `claims` (array of objects, optional)
  - `subject` (string, required)
  - `predicate` (string, required)
  - `object` (value, required)
  - `confidence` (number, required)
  - `evidence` (array of string, required)
  - `basis` (one of `observed`, `inferred`, required): observed: seen in code or output, or read in evidence attached to the brief; inferred: reasoned from what was seen
  - `cites` (array of string, optional): Task ids of the attached results (a grep, a read, a git history) this claim rests on; a claim about what attached evidence showed cites its task id, and is inferred if it cites evidence the brief did not carry
- `findings` (object or null, optional)
  - `summary` (string, required)
  - `observations` (array of objects, required)
    - `where` (string, required)
    - `what` (string, required)
- `needed` (array of objects, optional)
  - `kind` (one of `retrievable_fact`, `permission`, `missing_means`, `human_knowledge`, required)
  - `what` (string, required)

### A task session's result (`reproduce`): the resource's output

- `outcome` (one of `answered`, `insufficient`, required)
- `claims` (array of objects, optional)
  - `subject` (string, required)
  - `predicate` (string, required)
  - `object` (value, required)
  - `confidence` (number, required)
  - `evidence` (array of string, required)
  - `basis` (one of `observed`, `inferred`, required): observed: seen in code or output, or read in evidence attached to the brief; inferred: reasoned from what was seen
  - `cites` (array of string, optional): Task ids of the attached results (a grep, a read, a git history) this claim rests on; a claim about what attached evidence showed cites its task id, and is inferred if it cites evidence the brief did not carry
- `findings` (object or null, optional)
  - `observations` (array of objects, required)
    - `step` (string, required)
    - `observed` (string, required)
    - `screenshot` (string, optional): The path of the screenshot taken after this step, if one was
- `needed` (array of objects, optional)
  - `kind` (one of `retrievable_fact`, `permission`, `missing_means`, `human_knowledge`, required)
  - `what` (string, required)

### A task session's result (`interpret`): the resource's output

- `outcome` (one of `answered`, `insufficient`, required)
- `claims` (array of objects, optional)
  - `subject` (string, required)
  - `predicate` (string, required)
  - `object` (value, required)
  - `confidence` (number, required)
  - `evidence` (array of string, required)
  - `basis` (one of `observed`, `inferred`, required): observed: seen in code or output, or read in evidence attached to the brief; inferred: reasoned from what was seen
  - `cites` (array of string, optional): Task ids of the attached results (a grep, a read, a git history) this claim rests on; a claim about what attached evidence showed cites its task id, and is inferred if it cites evidence the brief did not carry
- `findings` (object or null, optional)
  - `conclusion` (string, required)
  - `reasoning` (string, required)
- `needed` (array of objects, optional)
  - `kind` (one of `retrievable_fact`, `permission`, `missing_means`, `human_knowledge`, required)
  - `what` (string, required)

### A deterministic task's output (`grep`), which is evidence and never claims

- `root` (string, required)
- `matches` (array of objects, required)
  - `file` (string, required)
  - `line` (integer, required)
  - `text` (string, required)
- `truncated` (boolean, required)

### A deterministic task's output (`read`), which is evidence and never claims

- `path` (string, required)
- `text` (string, required)
- `truncated` (boolean, required)
- `bytes` (integer, required)

### A deterministic task's output (`git_history`), which is evidence and never claims

- `branch` (string, required)
- `detached` (boolean, required)
- `changes` (array of objects, required)
  - `status` (string, required)
  - `path` (string, required)
  - `from` (string or null, required)
- `commits` (array of objects, required)
  - `hash` (string, required)
  - `date` (string, required)
  - `author` (string, required)
  - `subject` (string, required)

### A deterministic task's output (`check_path`), which is evidence and never claims

- `path` (string, required)
- `exists` (boolean, required)
- `kind` (one of `file`, `directory`, `other`, `missing`, required)
- `symlink` (boolean, required)
- `bytes` (integer or null, required)

### The handoff document (an outgoing IC to its successor): `HandoffDocument`

- `period` (object, required)
  - `objectives` (array of string, required): The current period's objectives, as you set them
  - `priorities` (array of string, required): The priorities as you restated or revised them
  - `why` (string, required): Why the objectives and priorities are what they are: what the reports and the file told you that chose them
- `units` (array of objects, required): Every active unit; a closed one only if its outcome still matters
  - `unitId` (string, required)
  - `state` (string, required): Where the unit stands against its objective, in your reading: what it has established, what it has left
  - `waitsOn` (string, optional): What the unit waits on, when it waits: a task in flight, an answer, a resource request
- `hypothesis` (object, required)
  - `statement` (string, required): Your current reading of the incident
  - `claims` (array of string, required): The claim ids it rests on; empty when it rests on none yet
- `setAside` (array of objects, required): Lines of inquiry, reports or suggestions you chose not to pursue, each with why, so your successor does not reopen them unknowingly
  - `what` (string, required)
  - `why` (string, required)
- `nextMove` (string, required): What you intended to do on your next turn, and what would have changed your mind

## Formats: what flows down, as JSON you assemble

The messages a seat receives are JSON you assemble from `incident.json` and `log.jsonl`, the same keys every time, so a seat reads state rather than prose and the tokens go to content; `incident_validator.mjs brief` checks each one before it is sent. A brief travels as a file in the run folder, and the seat receives one line naming it (`Brief file: <path>`) with the plugin root, the run folder and its id, so no brief passes through a session's own output twice. Every brief carries `returns`, the field list of the object the seat hands back, copied from the Formats section below. The structured answers above are what comes back. The role instructions are the only prose a seat gets; they are the bodies of the plugin's agents in `agents/`, one per seat (the IC's is `skills/noscope-run/role.md`), adapted from the TypeScript runtime's role texts.

| Message | To | Keys, in order |
|---|---|---|
| The size-up ask | The initial IC (Haiku) | `objective`, `constraints`, `priorities`, `workingDirectory`, and the ask to read around with the approved tools and return an `IncidentBriefing`. |
| Your own briefing | You, every turn | `change` (since your last turn: `reports`, each with its `situation` and the work beneath it as `work`, one ending per task with its `claims` by id, basis and confidence or its `evidence` as a count, a failure's `reason` and what it `cancelled`, an insufficiency's `needed`; `commandTasks` that ended; `answers`; `refusals`; `rejections`; `cancelled`), `incident` (the keys of `incident.json` whose value changed since your last turn; the whole file on a fresh session), and `unchanged` (the keys omitted). Tool calls are on the `call` events in the log, for analysis after the run, and in no brief. |
| The planner's ask | The planner | `incident.json` whole, `rules` (the checklist's table), `sinceLastPlan` (tasks completed, tasks insufficient or failed, and reports since the last plan was applied, as the TypeScript runtime's sections 4 to 6), `returns` (the `ActionPlan` fields), `models` and `seatModel`, and the ask to return an `ActionPlan` that works the open items under `situation.open` and holds to the rules, reading nothing but the brief. |
| The review ask | You | The valid draft with its tasks numbered `#N (ref)`, the validator's `WARN` lines, the statement that every rule holds, and the four substance questions; answer as a `ReviewTurn`. |
| A leader's orientation | A unit leader, first call | `objective` (the incident's), `unit` (`id`, `objective`, `equipment`, `bashAllowlist`), `hierarchy` (parent, siblings, children), `reassignment` when it takes one (`id`, the predecessor's `objective`, `instructions`, `claims` by id with subject, predicate, basis and confidence), `lastPicture` when it has reported before, `tasks` (every task of the unit so far: an ended one as its ending line, an open one as id, resource, status and objective), so a leader spawned mid-life starts from what its unit already did. Never your `situation`. |
| A leader's turn prompt | A unit leader, on a decision | `unheard` (each ending as `taskId`, `resource`, `status`, and for a completed task `summary` clipped and `claims` as id, subject, predicate, basis, confidence, or for a deterministic task `evidence` as a count; for a failure `reason` and `cancelled`; for an insufficiency `needed`), `refused` (its last assignments the validator rejected, with reasons), `revise` when one is due (`instructions`, `why`, the `report` reviewed, `periodObjectives`), `ready` and `running` task ids, and the ask (assign, consult or report as a `LeaderTurn`). |
| A task brief | A task session | `objective` (the incident's), `unit` (`id`, `objective`), `evidence` (`claims` named in `evidenceFrom.claims` in full; `results` of the tasks named in `evidenceFrom.tasks` in full), and the task's `objective`, `inputs`, `expectedOutput`, `completionCriteria`, `evidenceRequired`, `instructions`. Never your `situation`. |

