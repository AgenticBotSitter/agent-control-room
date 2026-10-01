import { isMainModuleV1 } from "../../src/installer/shared/is-main-module.mjs";
// Stops only PostgreSQL clusters that are demonstrably disposable, then removes
// only unattached SysV segments created by the stopped postmaster processes.
// Usage: node scripts/dev/cleanup-test-postgres.mjs [--dry-run]
import { execFile as execFileCallback } from "node:child_process";
import { lstat, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
export const DISPOSABLE_POSTGRES_MARKER = ".control-room-disposable-postgres.json";
const markerSchema = "control-room.disposable-postgres/v1";

export function parsePostgresProcesses(text) {
  const clusters = [];
  for (const line of text.split("\n")) {
    const match = /^\s*(\d+)\s+(.+)$/u.exec(line);
    if (!match || !/(?:^|\/)postgres(?:\s|$)/u.test(match[2])) continue;
    const data = /(?:^|\s)(?:-D\s+|--pgdata(?:=|\s+))([^\s]+)(?:\s|$)/u.exec(match[2])?.[1];
    if (data && isAbsolute(data)) clusters.push({ pid: Number(match[1]), dataDirectory: resolve(data) });
  }
  return clusters;
}

export function parseSharedMemory(text) {
  const header = text.split("\n").find(line => /\bNATTCH\b/u.test(line));
  if (!header) return [];
  const headings = header.trim().split(/\s+/u);
  const id = headings.indexOf("ID"), nattch = headings.indexOf("NATTCH"), cpid = headings.indexOf("CPID");
  if ([id, nattch, cpid].some(index => index < 0)) return [];
  return text.split("\n").slice(text.split("\n").indexOf(header) + 1).flatMap(line => {
    const fields = line.trim().split(/\s+/u);
    if (fields.length <= Math.max(id, nattch, cpid) || !fields.every((field, index) =>
      ![id, nattch, cpid].includes(index) || /^\d+$/u.test(field))) return [];
    return [{ id: fields[id], attachments: Number(fields[nattch]), creatorPid: Number(fields[cpid]) }];
  });
}

async function isDisposable(dataDirectory, runtime) {
  const temp = await runtime.realpath(runtime.tmpdir());
  let data;
  try { data = await runtime.realpath(dataDirectory); } catch { return false; }
  if (data.startsWith(`${temp}${sep}`)) return true;
  try {
    const path = join(data, DISPOSABLE_POSTGRES_MARKER), entry = await runtime.lstat(path);
    if (!entry.isFile() || entry.isSymbolicLink() || (entry.mode & 0o077) !== 0
      || (typeof process.getuid === "function" && entry.uid !== process.getuid())) return false;
    const marker = JSON.parse(await runtime.readFile(path, "utf8"));
    return marker?.schema === markerSchema && marker?.createdBy === "mac-local-rehearsal";
  } catch { return false; }
}

const production = Object.freeze({
  tmpdir, realpath, lstat, readFile,
  ps: async () => (await execFile("/bin/ps", ["-axo", "pid=,command="], { encoding: "utf8", timeout: 10_000 })).stdout,
  pgCtl: dataDirectory => execFile("/opt/homebrew/bin/pg_ctl", ["-D", dataDirectory, "stop", "-m", "fast"],
    { encoding: "utf8", timeout: 30_000 }),
  ipcs: async () => (await execFile("/usr/bin/ipcs", ["-m", "-o", "-p"], { encoding: "utf8", timeout: 10_000 })).stdout,
  ipcrm: id => execFile("/usr/bin/ipcrm", ["-m", id], { encoding: "utf8", timeout: 10_000 }),
});

export async function cleanupTestPostgres({ dryRun = false } = {}, runtime = production) {
  const processes = parsePostgresProcesses(await runtime.ps());
  const disposable = [];
  for (const process of processes) if (await isDisposable(process.dataDirectory, runtime)) disposable.push(process);
  const stoppedPids = new Set(disposable.map(process => process.pid));
  for (const cluster of disposable) if (!dryRun) await runtime.pgCtl(cluster.dataDirectory);
  const segments = parseSharedMemory(await runtime.ipcs())
    .filter(segment => segment.attachments === 0 && stoppedPids.has(segment.creatorPid));
  for (const segment of segments) if (!dryRun) await runtime.ipcrm(segment.id);
  return Object.freeze({ dryRun, clusters: disposable.map(value => Object.freeze({ ...value })),
    segments: segments.map(value => Object.freeze({ ...value })) });
}

const invoked = isMainModuleV1(process.argv[1], import.meta.url);
if (invoked) {
  const args = process.argv.slice(2);
  if (args.some(value => value !== "--dry-run")) {
    console.error("usage: node scripts/dev/cleanup-test-postgres.mjs [--dry-run]");
    process.exitCode = 2;
  } else {
    try {
      const result = await cleanupTestPostgres({ dryRun: args.includes("--dry-run") });
      console.log(`${result.dryRun ? "would stop" : "stopped"} ${result.clusters.length} disposable PostgreSQL cluster(s)`);
      console.log(`${result.dryRun ? "would remove" : "removed"} ${result.segments.length} unattached cluster segment(s)`);
    } catch (error) {
      console.error(`cleanup-test-postgres failed: ${error instanceof Error ? error.message : "unknown"}`);
      process.exitCode = 1;
    }
  }
}
