#!/usr/bin/env node
// references/protocol-objects.json, generated from the protocol. Each object a seat returns
// becomes a skeleton in the shape it is returned in, every value the instruction for that field,
// so a seat fills a shape instead of building one from a markdown field list.
//
//   node build_shapes.mjs           write references/protocol-objects.json
//   node build_shapes.mjs --check   exit non-zero if the file differs from what would be written
//
// The protocol is the source and this is derived: edit the protocol, then rebuild. A bullet is
// what starts a field, and any line that is not a bullet continues the description above it —
// the bullet marker is the delimiter, so a description that wraps can never be read as a nested
// child. Indentation alone was not enough: it was wrong for `scope` in five places, and a reader
// never noticed because a human takes the meaning from the fields around it.
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "references", "protocol-objects.json");
const NAMES = ["IncidentBriefing", "CommandTurn", "Situation", "ActionPlan", "ReviewTurn", "LeaderTurn", "UnitSituation", "HandoffDocument"];
const BULLET = /^(\s*)- `([^`]+)`\s*\(([^)]*)\)(?::\s*(.*))?$/;

const lines = readFileSync(join(ROOT, "references", "noscope-protocol.md"), "utf8").split("\n");
const sectionOf = (name) => {
  const s = lines.findIndex((l) => l.startsWith("### ") && l.includes(`\`${name}\``));
  if (s < 0) return null;
  let e = s + 1; while (e < lines.length && !lines[e].startsWith("### ") && !lines[e].startsWith("## ")) e++;
  return lines.slice(s, e);
};
function rowsOf(block) {
  const rows = [];
  for (const line of block) {
    const m = BULLET.exec(line);
    if (m) rows.push({ indent: m[1].length, key: m[2], meta: m[3].trim(), desc: (m[4] ?? "").trim() });
    else if (rows.length && line.trim() && !line.startsWith("###")) rows[rows.length - 1].desc = `${rows[rows.length - 1].desc} ${line.trim()}`.trim();
  }
  return rows;
}
function build(rows, i, indent) {
  const obj = {};
  while (i < rows.length && rows[i].indent >= indent) {
    const r = rows[i];
    if (r.indent > indent) { i++; continue; }
    const kids = i + 1 < rows.length && rows[i + 1].indent > indent;
    const note = `<${r.meta}${r.desc ? ` — ${r.desc}` : ""}>`;
    if (kids) { const [child, ni] = build(rows, i + 1, rows[i + 1].indent); obj[r.key] = r.meta.includes("array") ? [child] : child; i = ni; }
    else { obj[r.key] = r.meta.includes("array") ? [note] : note; i++; }
  }
  return [obj, i];
}

const shapes = {};
const lost = [];
for (const n of NAMES) {
  const block = sectionOf(n);
  if (!block) { lost.push(`${n}: the protocol has no section for it`); continue; }
  const rows = rowsOf(block);
  const [shape] = build(rows, 0, Math.min(...rows.map((r) => r.indent)));
  shapes[n] = shape;
  const out = (JSON.stringify(shape).match(/"[^"]+":/g) ?? []).length;
  if (out !== rows.length) lost.push(`${n}: ${rows.length} fields in the protocol, ${out} in the shape — a field is nested under the wrong parent, or two share a key at one level`);
}
if (lost.length) { console.error(lost.join("\n")); process.exit(1); }

const doc = { _README: [
  "The object each seat returns, in the shape it returns it in: every value is the instruction",
  "for that field. A seat is handed its own entry instead of a markdown field list, so it fills",
  "a shape rather than building one from prose.",
  "",
  "Generated from references/noscope-protocol.md by scripts/build_shapes.mjs. The protocol is the",
  "source and this is derived: edit the protocol, then rebuild. tests/scenario.sh runs --check and",
  "fails when this file and the protocol have drifted apart."
], shapes };
const text = JSON.stringify(doc, null, 2) + "\n";

if (process.argv.includes("--check")) {
  let have = null; try { have = readFileSync(OUT, "utf8"); } catch {}
  if (have !== text) { console.error("references/protocol-objects.json is not what the protocol would generate; run node scripts/build_shapes.mjs"); process.exit(1); }
  console.log(`protocol-objects.json matches the protocol (${NAMES.length} objects, ${(text.match(/"[^"]+":/g) ?? []).length} fields)`);
} else {
  writeFileSync(OUT, text);
  console.log(`wrote ${OUT}: ${NAMES.length} objects`);
  for (const n of NAMES) console.log(`  ${n.padEnd(20)} ${(JSON.stringify(shapes[n]).match(/"[^"]+":/g) ?? []).length} fields`);
}
