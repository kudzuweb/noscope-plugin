#!/usr/bin/env node
// Lends, for the length of one incident, the dialogs a fresh Claude Code session shows before
// its first turn: folder trust, and CLAUDE.md includes outside the project. A tab launched
// unattended would otherwise sit on the dialog until a human clicks it (seen 2026-09-21).
//
//   node incident_trust.mjs grant   <working-directory> <run folder>
//   node incident_trust.mjs release <run folder>
//
// A loan, not a gift. `grant` writes down what the three flags were before it touched them and
// which runs are holding them; `release` puts the old values back once the last run lets go, so
// a repository an incident visited is left as it was found. `incident_apply.mjs` releases every
// working directory when an incident reaches satisfied, failed or stopped, which is the same
// place a run's session markers are cleared.
//
// The ledger is ~/.claude/noscope/trust.json: one entry per working directory, holding the
// prior values and the run folders currently holding them. Two incidents on one repository both
// hold it, and the flags go back only when both have ended — restoring on the first ending would
// pull the dialog back up under a run that is still going.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { loadConfig, NOSCOPE_HOME } from "./incident_lib.mjs";

const FLAGS = ["hasTrustDialogAccepted", "hasClaudeMdExternalIncludesApproved", "hasClaudeMdExternalIncludesWarningShown"];
const CLAUDE_JSON = join(homedir(), ".claude.json");
const LEDGER = join(NOSCOPE_HOME, "trust.json");

const loadLedger = () => { try { return JSON.parse(readFileSync(LEDGER, "utf8")); } catch { return {}; } };
const saveLedger = (l) => { mkdirSync(NOSCOPE_HOME, { recursive: true }); writeFileSync(LEDGER, JSON.stringify(l, null, 2) + "\n"); };
function loadClaudeJson() {
  if (!existsSync(CLAUDE_JSON)) return null;
  try { return JSON.parse(readFileSync(CLAUDE_JSON, "utf8")); } catch { return null; }
}

const [mode, a, b] = process.argv.slice(2);

if (mode === "grant") {
  const wd = resolve(a ?? process.cwd());
  const runFolder = b ?? null;
  if (loadConfig().preAccept !== true) {
    console.log("preAccept is off; the launched tab will wait on its trust dialog until you click it");
    process.exit(0);
  }
  const d = loadClaudeJson();
  if (!d) { console.error("no readable ~/.claude.json yet; run claude once by hand"); process.exit(1); }
  d.projects ??= {};
  const e = (d.projects[wd] ??= { allowedTools: [] });
  const ledger = loadLedger();
  // The prior values are written down once, by the first run to hold this directory. A later
  // run must not record the flags it is already looking at, or the loan would restore `true`.
  if (!ledger[wd]) ledger[wd] = { prior: Object.fromEntries(FLAGS.map((f) => [f, e[f] ?? null])), holders: [] };
  if (runFolder && !ledger[wd].holders.includes(runFolder)) ledger[wd].holders.push(runFolder);
  const already = FLAGS.every((f) => e[f] === true);
  for (const f of FLAGS) e[f] = true;
  if (!already) writeFileSync(CLAUDE_JSON, JSON.stringify(d, null, 2));
  saveLedger(ledger);
  const held = ledger[wd].holders.length;
  console.log(`${already ? "already trusted" : "trusted"} ${wd} for the incident; ${held} run(s) holding it, and the previous values go back when the last one ends`);
}
else if (mode === "release") {
  const runFolder = a;
  if (!runFolder) { console.error("release needs the run folder that is letting go"); process.exit(2); }
  const ledger = loadLedger();
  const d = loadClaudeJson();
  let restored = 0, stillHeld = 0, changed = false;
  for (const [wd, entry] of Object.entries(ledger)) {
    if (!entry.holders?.includes(runFolder)) continue;
    entry.holders = entry.holders.filter((h) => h !== runFolder);
    if (entry.holders.length) { stillHeld++; continue; }
    if (d?.projects?.[wd]) {
      for (const f of FLAGS) {
        const was = entry.prior?.[f] ?? null;
        if (was === null || was === undefined) delete d.projects[wd][f]; else d.projects[wd][f] = was;
      }
      changed = true;
    }
    delete ledger[wd];
    restored++;
  }
  if (changed && d) writeFileSync(CLAUDE_JSON, JSON.stringify(d, null, 2));
  saveLedger(ledger);
  if (!restored && !stillHeld) console.log("nothing was lent for this run; nothing to put back");
  else console.log(`${restored} working director${restored === 1 ? "y" : "ies"} put back as found${stillHeld ? `, ${stillHeld} still held by another run` : ""}`);
}
else { console.error("usage: see the header of incident_trust.mjs"); process.exit(2); }
