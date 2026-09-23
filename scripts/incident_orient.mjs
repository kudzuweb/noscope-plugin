#!/usr/bin/env node
// The orientation a seat is given when it is spawned, assembled from named sections in
// references/orientation.json. One place holds each part — the hierarchy, the loop, how to write
// a prompt — and every seat kind lists the parts it gets, so a rule changed there reaches every
// seat on its next spawn instead of being restated in five role texts that drift apart.
//
//   node incident_orient.mjs <ic|leader|planner|sizeup|task>
//   node incident_orient.mjs <kind> --stamp     what to log: the file, its commit and the sections
//
// Nothing is stored per spawn. `--stamp` prints one line naming this file, the commit it was at
// and the sections used, which the spawning seat records; the assembled text is reconstructable
// from that commit, so the record says what a seat was told without keeping a copy of it.
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PATH = join(ROOT, "references", "orientation.json");
const doc = JSON.parse(readFileSync(PATH, "utf8"));

const kind = process.argv[2];
const stampOnly = process.argv.includes("--stamp");
const order = doc.assembly?.[kind];
if (!order) {
  console.error(`no seat kind "${kind}"; it is one of: ${Object.keys(doc.assembly ?? {}).join(", ")}`);
  process.exit(2);
}
for (const s of order) if (!doc.sections?.[s]) { console.error(`assembly for ${kind} names section "${s}", which this file has not got`); process.exit(2); }

if (stampOnly) {
  // The plugin's own commit, so the line resolves even when the incident runs on another repo.
  let commit = "unknown";
  try { commit = execFileSync("git", ["-C", ROOT, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim(); } catch {}
  console.log(`orientation: references/orientation.json@${commit} sections=${order.join(",")} seat=${kind}`);
} else {
  console.log(order.map((s) => doc.sections[s].join("\n")).join("\n\n"));
}
