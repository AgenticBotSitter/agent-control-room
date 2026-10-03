import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { updaterRefuseV1 } from "../contracts.mjs";
import { REHEARSAL_CASES_V1, rehearsalScenarioPendingV1 } from "./catalog.mjs";
import { prepareRehearsalRootV1 } from "./config.mjs";
import { REHEARSAL_IMPLEMENTATIONS_V1 } from "./scenarios.mjs";

const exec = promisify(execFile);
const nowId = clock => clock().toISOString().replaceAll(/[^0-9A-Za-z]/gu, "-");

async function atomicJson(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await import("node:fs/promises").then(fs => fs.rename(temporary, path));
}

async function installFakeCommands(root) {
  const directory = join(root, "runtime/rehearsal-fakes"), log = join(root, "evidence/fake-commands.jsonl");
  await mkdir(directory, { recursive: true }); await mkdir(join(root, "evidence"), { recursive: true });
  const bodies = {
    launchctl: `printf '{"command":"launchctl","arguments":"%s"}\\n' "$*" >> '${log}'`,
    sudo: `printf '{"command":"sudo","arguments":"%s"}\\n' "$*" >> '${log}'`,
    tailscale: `printf '{"command":"tailscale","arguments":"%s"}\\n' "$*" >> '${log}'`,
    pbcopy: `cat >/dev/null; printf '{"command":"pbcopy","arguments":"%s"}\\n' "$*" >> '${log}'`,
    pbpaste: `printf '{"command":"pbpaste","arguments":"%s"}\\n' "$*" >> '${log}'`,
    diskutil: "echo '   Owners: Enabled'",
  };
  for (const [name, body] of Object.entries(bodies)) {
    const path = join(directory, name);
    await rm(path, { force: true });
    await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o500, flag: "wx" });
    await chmod(path, 0o500);
  }
  return Object.freeze({ directory, log });
}

async function acquireRootLock(root, mayRemoveStale = true) {
  const path = join(root, ".rehearsal-running");
  const ownerPath = join(path, "owner.json"), token = randomUUID();
  try {
    await mkdir(path, { mode: 0o700 });
    await writeFile(ownerPath, `${JSON.stringify({ schema: "control-room.rehearsal-lock/v1",
      pid: process.pid, token })}\n`, { mode: 0o600, flag: "wx" });
  }
  catch (error) {
    if (error?.code === "EEXIST" && mayRemoveStale) {
      let owner;
      try { owner = JSON.parse(await readFile(ownerPath, "utf8")); } catch { owner = undefined; }
      if (Number.isSafeInteger(owner?.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); }
        catch (probeError) {
          if (probeError?.code === "ESRCH") {
            await rm(path, { recursive: true, force: true });
            return acquireRootLock(root, false);
          }
        }
      }
    }
    if (error?.code === "EEXIST") throw updaterRefuseV1("rehearsal_root_busy");
    await rm(path, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
  return async () => {
    try {
      const owner = JSON.parse(await readFile(ownerPath, "utf8"));
      if (owner?.token === token) await rm(path, { recursive: true, force: true });
    } catch { /* The disposable root may have been removed while the run was stopping. */ }
  };
}

async function createRunRoot(root, baseId) {
  for (let suffix = 1; suffix <= 1_000; suffix += 1) {
    const runId = suffix === 1 ? baseId : `${baseId}-${suffix}`;
    const runRoot = join(root, "evidence", runId);
    try { await mkdir(runRoot); return { runId, runRoot }; }
    catch (error) { if (error?.code !== "EEXIST") throw error; }
  }
  throw updaterRefuseV1("rehearsal_run_id_exhausted");
}

function assertScenarioEvidence(detail) {
  if (!detail || typeof detail !== "object" || Array.isArray(detail)
      || !Number.isInteger(detail.assertions) || detail.assertions < 1)
    throw updaterRefuseV1("rehearsal_assertion_evidence_missing");
  return detail;
}

async function realOwnersEnabled(root) {
  try { const result = await exec("/usr/sbin/diskutil", ["info", "/Volumes/CRRehearsal"]);
    return root.startsWith("/Volumes/CRRehearsal/") && /^\s*Owners:\s+Enabled\s*$/imu.test(result.stdout); }
  catch { return false; }
}

async function snapshotLinks(root) {
  const rows = {};
  for (const relative of ["current", "previous", "pg/current", "updater/current", "runtime/node-current",
    "runtime/pnpm-current", "runtime/pg-current", "runtime/esbuild-current"]) {
    try { rows[relative] = await readlink(join(root, relative)); }
    catch (error) { rows[relative] = error?.code === "ENOENT" ? null : `refused:${error?.code ?? "unknown"}`; }
  }
  return rows;
}

function markdownSummary(phases, metadata) {
  const lines = ["# Updater fault-injection rehearsal", "", `Run: \`${metadata.runId}\``,
    `Mode: \`${metadata.mode}\``, `Acceptance ready: **${metadata.acceptanceReady ? "yes" : "no"}**`, "",
    "| Case | Status | Passed checks | Pending checks | Failed checks | Evidence |",
    "|---|---:|---:|---:|---:|---|", ...phases.map(item => `| ${item.id} ${item.title} | ${item.status} | ${item.counts.pass} | ${item.counts.pending} | ${item.counts.fail} | \`${item.evidence}\` |`)];
  return `${lines.join("\n")}\n`;
}

async function writeScenarioEvidence(directory, scenario, result, startedAt, finishedAt, links) {
  await mkdir(directory, { recursive: true });
  const status = { schema: "control-room.updater-rehearsal-status/v1", caseId: scenario.id,
    status: result.status, reason: result.reason ?? null, startedAt, finishedAt };
  await atomicJson(join(directory, "result.json"), { ...status, title: scenario.title, detail: result.detail ?? null });
  await atomicJson(join(directory, "links.json"), links);
  await atomicJson(join(directory, "status.json"), status);
  await writeFile(join(directory, "journal.jsonl"), [
    JSON.stringify({ schema: "control-room.updater-rehearsal-journal/v1", event: "started", caseId: scenario.id, at: startedAt }),
    JSON.stringify({ schema: "control-room.updater-rehearsal-journal/v1", event: result.status, caseId: scenario.id,
      at: finishedAt, reason: result.reason ?? null }), "",
  ].join("\n"), { mode: 0o600 });
}

export async function runUpdaterRehearsalV1(config, { clock = () => new Date(), implementations = REHEARSAL_IMPLEMENTATIONS_V1,
  cases = REHEARSAL_CASES_V1, onPhase = () => {} } = {}) {
  const preflight = await prepareRehearsalRootV1(config, { ownersEnabled: config.mode === "real-root"
    ? realOwnersEnabled : async () => true });
  const releaseRootLock = await acquireRootLock(preflight.root);
  try {
    const fakes = config.mode === "throwaway" ? await installFakeCommands(preflight.root) : null;
    if (fakes) {
      const output = await exec(join(fakes.directory, "diskutil"), ["info", preflight.root]);
      if (!/^\s*Owners:\s+Enabled\s*$/imu.test(output.stdout)) throw new Error("rehearsal_disk_owners_disabled");
    }
    await mkdir(join(preflight.root, "evidence"), { recursive: true });
    const created = await createRunRoot(preflight.root, `rehearsal-${nowId(clock)}`);
    const { runId, runRoot } = created;
    const phases = [];
    for (const item of cases) {
      const phaseRoot = join(runRoot, item.id), results = [];
      await mkdir(join(phaseRoot, "scenarios"), { recursive: true });
      for (const scenario of item.scenarios) {
        const scenarioRoot = join(phaseRoot, "scenarios", scenario.id), work = join(scenarioRoot, "work");
        await mkdir(work, { recursive: true }); const startedAt = clock().toISOString(); let result;
        // A scenario the catalog marks runnable-on-Mac-only resolves to pending on
        // any other host, with its unblocking item, before its implementation runs.
        const unavailable = rehearsalScenarioPendingV1(scenario);
        if (scenario.pending !== undefined || unavailable !== undefined)
          result = { status: "pending", reason: unavailable ?? scenario.pending };
        else {
          try {
            const implementation = implementations[scenario.implementation];
            if (typeof implementation !== "function") throw new Error("rehearsal_implementation_missing");
            const detail = await implementation({ config, preflight, root: preflight.root,
              runRoot, phaseRoot, scenarioRoot, work, fakes });
            result = { status: "pass", detail: assertScenarioEvidence(detail) };
          } catch (error) {
            result = { status: "fail", reason: String(error?.code ?? error?.message ?? error),
              detail: { name: error?.name ?? "Error" } };
          }
        }
        const finishedAt = clock().toISOString(), links = await snapshotLinks(preflight.root);
        await writeScenarioEvidence(scenarioRoot, scenario, result, startedAt, finishedAt, links);
        results.push({ id: scenario.id, title: scenario.title, ...result,
          evidence: `${item.id}/scenarios/${scenario.id}` });
      }
      const counts = { pass: results.filter(row => row.status === "pass").length,
        pending: results.filter(row => row.status === "pending").length,
        fail: results.filter(row => row.status === "fail").length };
      const status = counts.fail > 0 ? "fail" : counts.pending > 0 ? "pending" : "pass";
      const phaseResult = { id: item.id, title: item.title, status, counts, scenarios: results,
        evidence: `${item.id}` };
      const at = clock().toISOString(); await atomicJson(join(phaseRoot, "result.json"), phaseResult);
      await atomicJson(join(phaseRoot, "links.json"), await snapshotLinks(preflight.root));
      await atomicJson(join(phaseRoot, "status.json"), { schema: "control-room.updater-rehearsal-status/v1",
        caseId: item.id, status, counts, at });
      await writeFile(join(phaseRoot, "journal.jsonl"), results.map(row => JSON.stringify({
        schema: "control-room.updater-rehearsal-journal/v1", event: row.status, caseId: row.id,
        reason: row.reason ?? null, evidence: row.evidence,
      })).join("\n") + "\n", { mode: 0o600 });
      phases.push(phaseResult); onPhase(phaseResult);
    }
    const metadata = { schema: "control-room.updater-rehearsal-summary/v1", runId, mode: config.mode,
      rehearsalHostname: config.rehearsalHostname, expectedOrigin: config.expectedOrigin,
      acceptanceReady: phases.every(item => item.status === "pass"),
      failed: phases.reduce((sum, item) => sum + item.counts.fail, 0),
      pending: phases.reduce((sum, item) => sum + item.counts.pending, 0),
      passed: phases.reduce((sum, item) => sum + item.counts.pass, 0) };
    const summary = { ...metadata, phases };
    await atomicJson(join(runRoot, "summary.json"), summary);
    await writeFile(join(runRoot, "summary.md"), markdownSummary(phases, metadata), { mode: 0o600 });
    return Object.freeze({ ...summary, runRoot, markdown: markdownSummary(phases, metadata) });
  } finally { await releaseRootLock(); }
}
