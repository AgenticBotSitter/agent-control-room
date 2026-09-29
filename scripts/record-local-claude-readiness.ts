/**
 * Converts a sanitized owner-run Claude qualification report into a redacted
 * setup-readiness record. It starts no process, writes no file, enables no
 * worker, and never prints an input path or report content.
 */
import { readFile } from "node:fs/promises";
import { recordClaudeCodeLocalQualificationReadinessV1 } from
  "../src/harness/claude-code-v1/installation-readiness-record";

const args = process.argv.slice(2).filter(value => value !== "--");
const fields = ["--plan", "--report", "--readiness"] as const;
type Field = typeof fields[number];

function valueFor(field: Field): string | undefined {
  const hits = args.reduce<number[]>((all, value, index) => value === field ? [...all, index] : all, []);
  if (hits.length !== 1 || hits[0] === args.length - 1) return undefined;
  const value = args[hits[0] + 1];
  return value && !value.startsWith("--") ? value : undefined;
}

const values = Object.fromEntries(fields.map(field => [field, valueFor(field)])) as Record<Field, string | undefined>;
const known = new Set<string>([...fields, ...Object.values(values).filter((value): value is string => Boolean(value))]);
const valid = args.every(value => known.has(value)) && Boolean(values["--plan"] && values["--report"]);

async function readJson(path: string): Promise<unknown> {
  const raw = await readFile(path, "utf8");
  if (Buffer.byteLength(raw) > 262_144) throw new Error("record_too_large");
  return JSON.parse(raw) as unknown;
}

if (!valid) {
  console.error("Usage: node --import tsx scripts/record-local-claude-readiness.ts --plan PLAN_JSON --report REPORT_JSON [--readiness READINESS_JSON]");
  process.exitCode = 2;
} else {
  try {
    const [plan, report, existing] = await Promise.all([
      readJson(values["--plan"]!),
      readJson(values["--report"]!),
      values["--readiness"] ? readJson(values["--readiness"]) : Promise.resolve(undefined),
    ]);
    console.log(JSON.stringify(recordClaudeCodeLocalQualificationReadinessV1(plan, report, existing), null, 2));
  } catch {
    console.log(JSON.stringify({ recorded: false, failureReason: "qualification_record_invalid" }, null, 2));
    process.exitCode = 1;
  }
}
