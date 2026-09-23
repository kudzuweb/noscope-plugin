---
name: noscope-audit
version: "0.1.0"
updated: "2026-09-22"
description: "Audit a finished noscope run for what it cost and what it wasted: where the bytes went, what the state carries, how many tokens each seat was handed against what it wrote, and a findings list of duplication and bloat with numbers attached. Invoke as /noscope-audit <run folder>. Reads the record only and changes nothing. Slash-command only."
---

# noscope-audit

What a run cost and what it wasted. `incident_review.mjs` says what happened in a run; this says
where the bytes and the tokens went, and which of them went twice. Read-only: it opens the run
folder and writes nothing.

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/incident_audit.mjs <run folder> --record
node ${CLAUDE_PLUGIN_ROOT}/scripts/incident_audit.mjs --compare <incidents dir>
```

`--record` keeps the run's metrics as one line in `<incidents dir>/metrics.jsonl`, replacing that
run's line rather than adding a second, so `--compare` puts every run measured so far in one
table. Always record: a run folder can be deleted, and the line outlives it.

Every number is measured. The token figures come from each session's own transcript, summed by
the Stop hook through `usageOfTranscript`, so they are the harness's accounting. The byte figures
are file sizes. Ratios and percentages are computed by the tool. **Do not recompute, estimate or
round any of them, and do not add a finding the tool did not print** — the checks are fixed, and
a number you worked out yourself is not comparable with the ones already recorded.

The run folder is `<incidentsDir>/<project>/<id>`. Without one, `node
${CLAUDE_PLUGIN_ROOT}/scripts/incident_current.mjs` prints the incident open in this directory.

## What it prints, and what to make of it

| Section | Read it for |
|---|---|
| Where the bytes are | Which kind of file the run folder is made of. Briefs above about a third of the folder means seats are being handed copies of the state rather than slices of it. |
| The state | What every seat handed the state whole has to read. `tasks` dominating means bodies are being kept in the record instead of a line and a path to the file that already holds them. |
| Model calls | Cache read is the real input: it is the context handed to a seat again on every call it makes, and it is normally 90% or more of everything billed. The in/out ratio says how much a seat reads per token it writes. |
| What to fix | Only what is actually present in this run, each with its numbers. An empty list means these checks found nothing. |

Two things the numbers mean that are easy to read the wrong way. A high cache-read figure is not
waste by itself — it is what caching is for — but it multiplies: a seat's context is re-read on
every turn it takes, so a brief that is twice as large costs twice as much on every turn of every
seat that gets it. And a seat's cost is driven by what it is handed far more than by what it
writes, so the lever is always the size of the brief, not the length of the answer.

## Reporting it

Give the human the findings with their numbers, largest first, and say what each one would take
to fix. Where a finding names a file or a task id, keep the id: it is what they will look up.
Never report a finding the tool did not print, and never soften one — the numbers are measured
from the record, and the arithmetic is the tool's, not yours.

If the run is clean, say so in one line rather than finding something to say.

To compare against earlier runs, run `--compare` and read the table. A run that is larger or
dearer than an earlier one is not worse by itself — a four-period incident costs more than a
two-period one — so compare the ratios, `in/out` and `cache %` and the state size, which say how
much a seat was handed per token it wrote rather than how much work the run did.
