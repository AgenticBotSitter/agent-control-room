/**
 * Converts an already-sanitized owner qualification report into the opaque
 * installation-readiness record used by the private Control Room screen.
 *
 * It is deliberately read-only: it starts no harness, writes no configuration,
 * and prints no supplied file name, report contents, model, profile, path, or
 * credential. The installer remains responsible for storing the returned
 * record through its protected configuration path.
 */
import { readFile } from "node:fs/promises";
import {
  recordHermes021MacosLocalQualificationReadinessV1,
  recordHermes021MacosLocalRunnerQualificationReadinessV1,
  recordLocalBackupRestoreReadinessV1,
} from "../src/harness/hermes-021-v1/installation-readiness-record";

const args = process.argv.slice(2).filter(value => value !== "--");
const fields = ["--kind", "--plan", "--report", "--readiness"] as const;
type Field = typeof fields[number];

function valueFor(field: Field): string | undefined {
  const indexes = args.reduce<number[]>((all, value, index) => value === field ? [...all, index] : all, []);
  if (indexes.length !== 1 || indexes[0] === args.length - 1) return undefined;
  const value = args[indexes[0] + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

const values = Object.fromEntries(fields.map(field => [field, valueFor(field)])) as Record<Field, string | undefined>;
const known = new Set<string>([...fields, ...Object.values(values).filter((value): value is string => Boolean(value))]);
const kind = values["--kind"];
const valid = args.every(value => known.has(value)) && (kind === "text" || kind === "runner" || kind === "backup")
  && Boolean(values["--plan"]) && Boolean(values["--report"]);

async function readJson(path: string): Promise<unknown> {
  const raw = await readFile(path, "utf8");
  // Qualification records are deliberately small. Refuse accidental log or
  // export files rather than holding their contents in this installer helper.
  if (Buffer.byteLength(raw) > 262_144) throw new Error("record_too_large");
  return JSON.parse(raw) as unknown;
}

if (!valid) {
  console.error("Usage: node --import tsx scripts/record-local-hermes-readiness.ts --kind text|runner|backup --plan PLAN_JSON --report REPORT_JSON [--readiness READINESS_JSON]");
  process.exitCode = 2;
} else {
  try {
    const [plan, report, existing] = await Promise.all([
      readJson(values["--plan"]!), readJson(values["--report"]!),
      values["--readiness"] ? readJson(values["--readiness"]) : Promise.resolve(undefined),
    ]);
    const readiness = kind === "text"
      ? recordHermes021MacosLocalQualificationReadinessV1(plan, report, existing)
      : kind === "runner"
        ? recordHermes021MacosLocalRunnerQualificationReadinessV1(plan, report, existing)
        : recordLocalBackupRestoreReadinessV1(plan, report, existing);
    // Readiness contains only a plan digest, proof names/states and evidence
    // digests. It cannot disclose the report or a private runner setting.
    console.log(JSON.stringify(readiness, null, 2));
  } catch {
    console.log(JSON.stringify({ recorded: false, failureReason: "qualification_record_invalid" }, null, 2));
    process.exitCode = 1;
  }
}
