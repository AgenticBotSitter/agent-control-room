/**
 * Converts an already-sanitized owner review of local service preparation into
 * the opaque record displayed by the protected setup page.  It is deliberately
 * read-only: it never installs, starts, stops, or inspects a supervisor.
 */
import { readFile } from "node:fs/promises";
import { createLocalSupervisorReadinessV1 } from "../src/harness/v1/local-supervisor-readiness";

const args = process.argv.slice(2).filter(value => value !== "--");
const fields = ["--report"] as const;
type Field = typeof fields[number];

function valueFor(field: Field): string | undefined {
  const indexes = args.reduce<number[]>((all, value, index) => value === field ? [...all, index] : all, []);
  if (indexes.length !== 1 || indexes[0] === args.length - 1) return undefined;
  const value = args[indexes[0] + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

const values = Object.fromEntries(fields.map(field => [field, valueFor(field)])) as Record<Field, string | undefined>;
const known = new Set<string>([...fields, ...Object.values(values).filter((value): value is string => Boolean(value))]);
const valid = args.every(value => known.has(value)) && Boolean(values["--report"]);

async function readJson(path: string): Promise<unknown> {
  const raw = await readFile(path, "utf8");
  // A service-manager export, logs, or configuration file is not a readiness
  // report. Bound input before parsing so the recorder never holds one.
  if (Buffer.byteLength(raw) > 32 * 1024) throw new Error("report_too_large");
  return JSON.parse(raw) as unknown;
}

if (!valid) {
  console.error("Usage: node --import tsx scripts/record-local-supervisor-readiness.ts --report SUPERVISOR_REPORT_JSON");
  process.exitCode = 2;
} else {
  try {
    const report = await readJson(values["--report"]!);
    // The factory parses the unknown input itself.  The cast keeps the CLI
    // boundary explicit to TypeScript without making the runtime parser trust
    // a JSON file merely because it reached this line.
    const readiness = createLocalSupervisorReadinessV1(report as Parameters<typeof createLocalSupervisorReadinessV1>[0]);
    // The returned record contains only a plan digest, proof names/states, and
    // opaque evidence digests. It cannot reveal a service, account, command,
    // configuration location, or report contents.
    console.log(JSON.stringify(readiness, null, 2));
  } catch {
    console.log(JSON.stringify({ recorded: false, failureReason: "local_service_readiness_record_invalid" }, null, 2));
    process.exitCode = 1;
  }
}
