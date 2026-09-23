#!/usr/bin/env node
// The failsafe's launchd agent: installs, removes and reports on the timer that runs
// incident_watch.mjs. A failsafe cannot depend on the thing it is watching, so this is a system
// timer rather than anything inside a run: it survives every session dying, the incident being
// abandoned mid-turn, and the machine rebooting.
//
//   node incident_daemon.mjs ensure [--minutes N]    load it if it is not already (what a run calls)
//   node incident_daemon.mjs stop-if-idle            unload it, but only when no run is registered
//   node incident_daemon.mjs install [--minutes N]   load it whether or not it is already loaded
//   node incident_daemon.mjs status                  whether it is loaded, and what it last found
//   node incident_daemon.mjs uninstall               unload and remove it, whatever is registered
//
// It runs for as long as there is something to watch and no longer. incident_init.mjs ensures it
// when a run opens and incident_apply.mjs stops it when the last run ends — the last, not any, so
// one incident finishing never blinds the failsafe to another still going.
//
// The agent calls `incident_watch.mjs --all --notify`, which looks only at the runs that
// registered themselves and drops registrations whose record is gone or finished. So the timer
// takes no arguments that go stale, and an incident that ends needs to tell nothing here.
//
// macOS only. On anything else install prints the command to run on a timer and exits 0, because
// the watcher is the useful part and it runs anywhere.
//
// launchctl is called through spawnSync with an argument array and never a shell string, so no
// value here is ever tokenised by one.
import { existsSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir, platform } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { NOSCOPE_HOME, loadWatching } from "./incident_lib.mjs";

const LABEL = "com.noscope.watch";
const AGENTS = join(homedir(), "Library", "LaunchAgents");
const PLIST = join(AGENTS, `${LABEL}.plist`);
const LOG = join(NOSCOPE_HOME, "watch.log");
const WATCH = join(dirname(fileURLToPath(import.meta.url)), "incident_watch.mjs");
// The agent runs this, never the plugin's own path. An installed plugin lives under
// .../cache/<marketplace>/<plugin>/<version>/, so a plist aimed into it points at a directory
// that `claude plugin update` prunes, and the failsafe would die silently at the next update —
// the same trap the status line is copied out of the plugin to avoid. A copy would not do here,
// since the watcher imports the rest of scripts/, so this is a shim that finds the newest
// installed copy each time it runs and falls back to the path installed from.
const SHIM = join(NOSCOPE_HOME, "watch.sh");

const args = process.argv.slice(2);
const mode = args[0];
const flag = (n, d) => { const i = args.indexOf(n); return i === -1 ? d : args[i + 1]; };
const uid = process.getuid?.() ?? 501;
const launchctl = (...a) => spawnSync("launchctl", a, { encoding: "utf8" });

if (!["install", "status", "uninstall", "ensure", "stop-if-idle"].includes(mode)) {
  console.error("usage: incident_daemon.mjs ensure [--minutes N] | stop-if-idle | install [--minutes N] | status | uninstall");
  process.exit(2);
}
const isLoaded = () => launchctl("print", `gui/${uid}/${LABEL}`).status === 0;

// The scenario opens and ends runs, which would load and unload a launchd agent on the machine
// running the tests — and leave one loaded if a step between the two failed. NOSCOPE_NO_DAEMON
// turns the two modes a run calls into no-ops, so a test never touches launchctl. It does not
// silence install, status or uninstall, which are only ever asked for by hand.
if (process.env.NOSCOPE_NO_DAEMON && ["ensure", "stop-if-idle"].includes(mode)) {
  console.log(`NOSCOPE_NO_DAEMON is set: ${mode} did nothing`);
  process.exit(0);
}

// The watcher runs anywhere; only the timer is macOS's. Saying so beats installing nothing silently.
if (platform() !== "darwin") {
  console.log(`the failsafe timer is a launchd agent and this machine is ${platform()}.`);
  console.log(`run this on a timer of your own, every 10 minutes:\n  ${process.execPath} ${WATCH} --all --notify`);
  process.exit(0);
}

// Called by a run as it opens. Loading an agent that is already loaded would work, but checking
// first keeps a second incident from bouncing the timer the first one is relying on.
if (mode === "ensure") {
  if (isLoaded()) { console.log(`${LABEL} is already watching`); process.exit(0); }
  // fall through to install
}

// Called as a run ends. The registry is the authority on whether anything is left to watch, so a
// second incident still open keeps the failsafe up even though this one is finished.
if (mode === "stop-if-idle") {
  const left = Object.keys(loadWatching());
  if (left.length > 0) {
    console.log(`${LABEL} stays up: ${left.length} run(s) still registered`);
    process.exit(0);
  }
  if (!isLoaded() && !existsSync(PLIST)) { console.log(`${LABEL} was not running`); process.exit(0); }
  const r = launchctl("bootout", `gui/${uid}/${LABEL}`);
  if (existsSync(PLIST)) rmSync(PLIST);
  if (existsSync(SHIM)) rmSync(SHIM);
  console.log(r.status === 0 ? `${LABEL} stopped; no run is left to watch` : `${LABEL} removed; it was not loaded`);
  process.exit(0);
}

if (mode === "uninstall") {
  const r = launchctl("bootout", `gui/${uid}/${LABEL}`);
  if (existsSync(PLIST)) rmSync(PLIST);
  if (existsSync(SHIM)) rmSync(SHIM);
  console.log(r.status === 0 ? `${LABEL} unloaded and removed` : `${LABEL} removed; it was not loaded (${(r.stderr || "").trim()})`);
  process.exit(0);
}

if (mode === "status") {
  const r = launchctl("print", `gui/${uid}/${LABEL}`);
  const loaded = r.status === 0;
  console.log(`${LABEL}: ${loaded ? "loaded" : "not loaded"}`);
  console.log(`plist: ${existsSync(PLIST) ? PLIST : "not written"}`);
  console.log(`shim: ${existsSync(SHIM) ? SHIM : "not written"}`);
  if (loaded) {
    const every = /StartInterval\s*=\s*(\d+)/.exec(r.stdout ?? "");
    if (every) console.log(`runs every ${Math.round(Number(every[1]) / 60)} minute(s)`);
  }
  if (existsSync(LOG)) {
    const tail = readFileSync(LOG, "utf8").trim().split("\n").slice(-6);
    console.log(`last from ${LOG}:`);
    for (const l of tail) console.log(`  ${l}`);
  } else console.log(`no log at ${LOG} yet`);
  process.exit(loaded ? 0 : 1);
}

// install
const minutes = Number(flag("--minutes", 10));
if (!Number.isFinite(minutes) || minutes <= 0) { console.error("--minutes must be a positive number"); process.exit(2); }

mkdirSync(AGENTS, { recursive: true });
mkdirSync(NOSCOPE_HOME, { recursive: true });

// The script path is the installed plugin's, which stays put across plugin updates: the cache
// folder is named for the plugin and not for its version. A `claude plugin update` therefore
// leaves this agent pointing at the new code, which is what a failsafe should do.
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${SHIM}</string>
  </array>
  <key>StartInterval</key><integer>${Math.round(minutes * 60)}</integer>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict>
</plist>
`;
// The shim, written before the plist that calls it.
const shim = `#!/usr/bin/env bash
# Runs noscope's failsafe watcher. Written by incident_daemon.mjs and called by the launchd agent
# com.noscope.watch, which must not name a versioned path: an installed plugin lives under
# .../cache/<marketplace>/<plugin>/<version>/ and that directory is pruned on the next update.
# So the version is resolved here, every run, and the path installed from is the fallback.
set -u
newest=""
for d in "$HOME"/.claude/plugins/cache/*/noscope/*/scripts/incident_watch.mjs; do
  [ -f "$d" ] || continue
  v=$(basename "$(dirname "$(dirname "$d")")")
  if [ -z "$newest" ] || [ "$(printf '%s\\n%s\\n' "$newest_v" "$v" | sort -V | tail -1)" = "$v" ]; then
    newest="$d"; newest_v="$v"
  fi
done
[ -n "$newest" ] || newest=${JSON.stringify(WATCH)}
[ -f "$newest" ] || { echo "$(date -u +%FT%TZ) noscope watch: no incident_watch.mjs found" >&2; exit 0; }
exec ${JSON.stringify(process.execPath)} "$newest" --all --notify
`;
writeFileSync(SHIM, shim, { mode: 0o755 });
writeFileSync(PLIST, plist);

launchctl("bootout", `gui/${uid}/${LABEL}`);          // replace any earlier copy; failure is fine
const boot = launchctl("bootstrap", `gui/${uid}`, PLIST);
if (boot.status !== 0) {
  console.error(`wrote ${PLIST} but launchctl bootstrap failed: ${(boot.stderr || "").trim()}`);
  console.error(`load it by hand with:\n  launchctl bootstrap gui/${uid} ${PLIST}`);
  process.exit(1);
}
console.log(`${LABEL} ${mode === "ensure" ? "started" : "installed"}: ${SHIM}, every ${minutes} minute(s)`);
console.log("it resolves the newest installed plugin each run, so a plugin update does not strand it");
console.log(`log: ${LOG}`);
console.log("it watches the runs that registered themselves, and stops watching one when it ends");
process.exit(0);
