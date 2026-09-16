// Read-only daily activity report from explicit, sanitized session records.
// Missing time remains unknown: availability, claims and gaps never imply activity.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const DAILY_ACTIVITY_SCHEMA_V1 = "acr-daily-activity:v1";
export const ACTIVITY_CATEGORIES = Object.freeze([
  "building", "testing", "reviewing", "managing", "idle", "blocked", "offline",
]);
export const PRODUCTIVE_CATEGORIES = Object.freeze(["building", "testing", "reviewing", "managing"]);

const CATEGORY_SET = new Set(ACTIVITY_CATEGORIES);
const PRODUCTIVE_SET = new Set(PRODUCTIVE_CATEGORIES);
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "unknown"]);
// Match the public workflow's stable-ID alphabet. The producer is responsible
// for assigning a role-based pseudonym; this report never guesses or rewrites it.
const ROLE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,79}$/;
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const MODEL = /^(?:unknown|[A-Za-z0-9][A-Za-z0-9 ._:/+()-]{0,79})$/;
const MINUTE_MS = 60_000;
const INPUT_KEYS = new Set(["schema", "workerIds", "availability", "intervals"]);
const AVAILABILITY_KEYS = new Set(["workerId", "start", "end"]);
const INTERVAL_KEYS = new Set(["id", "workerId", "model", "effort", "category", "start", "end", "evidence"]);

function fail(reason) { throw new Error(`daily_activity_${reason}`); }
function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.size && Object.keys(value).every(key => keys.has(key));
}
function exactInputKeys(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).every(key => INPUT_KEYS.has(key))
    && ["schema", "availability", "intervals"].every(key => Object.hasOwn(value, key));
}
function instant(value, nowMs, allowFuture = false) {
  const match = typeof value === "string"
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value)
    : undefined;
  if (!match) fail("instant_invalid");
  const [, year, month, day, hour, minute, second, zone] = match;
  const offset = zone === "Z" ? undefined : zone.slice(1).split(":").map(Number);
  const days = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > days
    || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59
    || (offset && (offset[0] > 14 || offset[1] > 59 || (offset[0] === 14 && offset[1] !== 0)))) fail("instant_invalid");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || parsed < 0) fail("instant_invalid");
  if (!allowFuture && parsed > nowMs) fail("instant_future");
  return parsed;
}
function workerId(value) {
  if (typeof value !== "string" || !ROLE_ID.test(value)) fail("worker_id_invalid");
  return value;
}
function evidence(value) {
  if (value === "self-reported") return value;
  if (typeof value !== "string") fail("evidence_invalid");
  let url;
  try { url = new URL(value); } catch { fail("evidence_invalid"); }
  if (value !== value.trim() || url.protocol !== "https:" || url.hostname !== "github.com"
    || url.username || url.password || url.port || url.search
    || !(url.pathname === "/AgenticBotSitter/agent-control-room"
      || url.pathname.startsWith("/AgenticBotSitter/agent-control-room/"))) fail("evidence_invalid");
  return value;
}
function span(value, nowMs, allowFuture = false) {
  const startMs = instant(value.start, nowMs, allowFuture), endMs = instant(value.end, nowMs, allowFuture);
  if (endMs <= startMs) fail("interval_reversed");
  return { startMs, endMs };
}

/** Strictly validate and normalize one untrusted activity document. */
export function parseDailyActivity(value, { nowMs = Date.now() } = {}) {
  if (!Number.isFinite(nowMs) || nowMs < 0) fail("now_invalid");
  if (!exactInputKeys(value) || value.schema !== DAILY_ACTIVITY_SCHEMA_V1
    || (value.workerIds !== undefined && !Array.isArray(value.workerIds))
    || !Array.isArray(value.availability) || !Array.isArray(value.intervals)) fail("input_invalid");
  const workerIds = (value.workerIds ?? []).map(workerId);
  if (new Set(workerIds).size !== workerIds.length) fail("worker_id_duplicate");
  const availability = value.availability.map(entry => {
    if (!exactKeys(entry, AVAILABILITY_KEYS)) fail("availability_invalid");
    return Object.freeze({ workerId: workerId(entry.workerId), ...span(entry, nowMs, true) });
  });
  const ids = new Set();
  const intervals = value.intervals.map(entry => {
    if (!exactKeys(entry, INTERVAL_KEYS) || typeof entry.id !== "string" || !RECORD_ID.test(entry.id))
      fail("interval_invalid");
    if (ids.has(entry.id)) fail("interval_id_duplicate");
    ids.add(entry.id);
    if (!CATEGORY_SET.has(entry.category)) fail("category_invalid");
    if (typeof entry.model !== "string" || !MODEL.test(entry.model)) fail("model_invalid");
    if (typeof entry.effort !== "string" || !EFFORTS.has(entry.effort)) fail("effort_invalid");
    return Object.freeze({ id: entry.id, workerId: workerId(entry.workerId), model: entry.model,
      effort: entry.effort, category: entry.category, evidence: evidence(entry.evidence), ...span(entry, nowMs) });
  });
  return Object.freeze({ schema: DAILY_ACTIVITY_SCHEMA_V1,
    workerIds: Object.freeze(workerIds), availability: Object.freeze(availability), intervals: Object.freeze(intervals) });
}

function selectedWindow(start, end, nowMs) {
  const startMs = instant(start, nowMs), endMs = instant(end, nowMs);
  if (endMs <= startMs) fail("window_reversed");
  return { startMs, endMs };
}
function clip(spans, startMs, endMs) {
  return spans.map(value => ({ ...value, startMs: Math.max(value.startMs, startMs), endMs: Math.min(value.endMs, endMs) }))
    .filter(value => value.endMs > value.startMs);
}
function union(spans) {
  const merged = [];
  for (const value of spans.map(({ startMs, endMs }) => [startMs, endMs])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1])) {
    const last = merged.at(-1);
    if (!last || value[0] > last[1]) merged.push(value);
    else last[1] = Math.max(last[1], value[1]);
  }
  return merged;
}
function durationMinutes(spans) {
  return spans.reduce((total, [startMs, endMs]) => total + endMs - startMs, 0) / MINUTE_MS;
}
function intersectionMinutes(left, right) {
  let total = 0, i = 0, j = 0;
  while (i < left.length && j < right.length) {
    total += Math.max(0, Math.min(left[i][1], right[j][1]) - Math.max(left[i][0], right[j][0]));
    if (left[i][1] < right[j][1]) i++; else j++;
  }
  return total / MINUTE_MS;
}
function percent(minutes, denominator) { return denominator > 0 ? minutes / denominator * 100 : null; }

function resolveWorker(intervals, startMs, endMs) {
  const boundaries = [...new Set([startMs, endMs, ...intervals.flatMap(value => [value.startMs, value.endMs])])]
    .sort((left, right) => left - right);
  const segments = [], minutes = Object.fromEntries(ACTIVITY_CATEGORIES.map(category => [category, 0]));
  minutes.unknown = 0;
  for (let index = 0; index < boundaries.length - 1; index++) {
    const from = boundaries[index], to = boundaries[index + 1];
    const active = intervals.filter(value => value.startMs < to && value.endMs > from);
    const signatures = new Set(active.map(value => `${value.category}\0${value.model}\0${value.effort}`));
    const resolved = signatures.size === 1 ? active[0] : undefined;
    const category = resolved?.category ?? "unknown";
    minutes[category] += (to - from) / MINUTE_MS;
    segments.push({ startMs: from, endMs: to, category,
      model: resolved?.model, effort: resolved?.effort, observed: Boolean(resolved) });
  }
  return { minutes, segments };
}

/** Build the bounded report. This function performs no I/O and never infers idle time. */
export function summarizeDailyActivity(input, { start, end, nowMs = Date.now() } = {}) {
  const parsed = parseDailyActivity(input, { nowMs });
  const { startMs, endMs } = selectedWindow(start, end, nowMs);
  const elapsedMinutes = (endMs - startMs) / MINUTE_MS;
  const ids = [...new Set([...parsed.workerIds, ...parsed.availability.map(value => value.workerId),
    ...parsed.intervals.map(value => value.workerId)])].sort();
  const models = new Map(), teamProductive = [];
  const workers = ids.map(id => {
    const intervals = clip(parsed.intervals.filter(value => value.workerId === id), startMs, endMs);
    const resolved = resolveWorker(intervals, startMs, endMs);
    const productive = union(resolved.segments.filter(value => PRODUCTIVE_SET.has(value.category)));
    teamProductive.push(...productive.map(([segmentStart, segmentEnd]) => ({ startMs: segmentStart, endMs: segmentEnd })));
    for (const segment of resolved.segments) {
      if (!segment.observed) continue;
      const key = `${segment.model}\0${segment.effort}`;
      const row = models.get(key) ?? { model: segment.model, effort: segment.effort,
        selfReportedMinutes: 0, selfReportedProductiveMinutes: 0, selfReportedNonworkMinutes: 0 };
      const segmentMinutes = (segment.endMs - segment.startMs) / MINUTE_MS;
      row.selfReportedMinutes += segmentMinutes;
      if (PRODUCTIVE_SET.has(segment.category)) row.selfReportedProductiveMinutes += segmentMinutes;
      else row.selfReportedNonworkMinutes += segmentMinutes;
      models.set(key, row);
    }
    const availabilityRecords = parsed.availability.filter(value => value.workerId === id);
    const available = union(clip(availabilityRecords, startMs, endMs));
    const availableMinutes = durationMinutes(available);
    const productiveAvailableMinutes = intersectionMinutes(productive, available);
    const known = union(resolved.segments.filter(value => value.observed));
    const availableKnownMinutes = intersectionMinutes(known, available);
    const productiveMinutes = PRODUCTIVE_CATEGORIES.reduce((total, category) => total + resolved.minutes[category], 0);
    const buildTestMinutes = resolved.minutes.building + resolved.minutes.testing;
    const reviewManageMinutes = resolved.minutes.reviewing + resolved.minutes.managing;
    return Object.freeze({ workerId: id, observedMinutes: Object.freeze(resolved.minutes),
      percentages: Object.freeze(Object.fromEntries(Object.entries(resolved.minutes)
        .map(([category, value]) => [category, percent(value, elapsedMinutes)]))),
      productiveMinutes, productivePercent: percent(productiveMinutes, elapsedMinutes),
      buildTestMinutes, buildTestPercent: percent(buildTestMinutes, elapsedMinutes),
      reviewManageMinutes, reviewManagePercent: percent(reviewManageMinutes, elapsedMinutes),
      scheduledAvailabilityMinutes: availabilityRecords.length ? availableMinutes : null,
      productiveWithinAvailabilityMinutes: availabilityRecords.length ? productiveAvailableMinutes : null,
      availableProductivePercent: availabilityRecords.length && availableMinutes > 0
        ? percent(productiveAvailableMinutes, availableMinutes) : null,
      availableKnownMinutes: availabilityRecords.length ? availableKnownMinutes : null,
      availableUnknownMinutes: availabilityRecords.length ? availableMinutes - availableKnownMinutes : null,
      availableReportingCompletenessPercent: availabilityRecords.length && availableMinutes > 0
        ? percent(availableKnownMinutes, availableMinutes) : null });
  });
  const productiveCoverageMinutes = durationMinutes(union(teamProductive));
  return Object.freeze({ schema: DAILY_ACTIVITY_SCHEMA_V1,
    window: Object.freeze({ start: new Date(startMs).toISOString(), end: new Date(endMs).toISOString(), elapsedMinutes }),
    workers: Object.freeze(workers),
    team: Object.freeze({ productiveCoverageMinutes, productiveCoveragePercent: percent(productiveCoverageMinutes, elapsedMinutes) }),
    models: Object.freeze([...models.values()].sort((left, right) => left.model.localeCompare(right.model)
      || left.effort.localeCompare(right.effort)).map(Object.freeze)),
    note: "Activity and model time are self-reported. Model work and non-work are separate. Unreported or conflicting time is unknown; gaps are never inferred as idle, and availability is not evidence of activity." });
}

function shown(value) { return value === null ? "unknown" : Number(value.toFixed(2)).toString(); }

export function renderDailyActivity(report) {
  const categories = [...ACTIVITY_CATEGORIES, "unknown"];
  const lines = [`Daily activity | ${report.window.start} to ${report.window.end}`,
    `Window elapsed: ${shown(report.window.elapsedMinutes)} minutes`,
    `WORKER | ${categories.map(value => `${value.toUpperCase()} MIN (%)`).join(" | ")} | WORK MIN (%) | BUILD+TEST MIN (%) | REVIEW+MANAGE MIN (%) | AVAILABLE | WORK IN AVAILABLE | AVAILABLE WORK % | AVAILABLE KNOWN | AVAILABLE UNKNOWN | REPORTING COMPLETE %`];
  for (const worker of report.workers) lines.push([worker.workerId,
    ...categories.map(category => `${shown(worker.observedMinutes[category])} (${shown(worker.percentages[category])}%)`),
    `${shown(worker.productiveMinutes)} (${shown(worker.productivePercent)}%)`,
    `${shown(worker.buildTestMinutes)} (${shown(worker.buildTestPercent)}%)`,
    `${shown(worker.reviewManageMinutes)} (${shown(worker.reviewManagePercent)}%)`,
    shown(worker.scheduledAvailabilityMinutes), shown(worker.productiveWithinAvailabilityMinutes),
    shown(worker.availableProductivePercent), shown(worker.availableKnownMinutes), shown(worker.availableUnknownMinutes),
    shown(worker.availableReportingCompletenessPercent)].join(" | "));
  lines.push("", `Team productive coverage: ${shown(report.team.productiveCoverageMinutes)} minutes (${shown(report.team.productiveCoveragePercent)}%)`,
    "", "MODEL | EFFORT | SELF-REPORTED WORK MIN | SELF-REPORTED NON-WORK MIN | TOTAL REPORTED MIN");
  if (!report.models.length) lines.push("none | unknown | 0 | 0 | 0");
  else for (const row of report.models) lines.push(`${row.model} | ${row.effort} | ${shown(row.selfReportedProductiveMinutes)} | ${shown(row.selfReportedNonworkMinutes)} | ${shown(row.selfReportedMinutes)}`);
  lines.push("No model ranking is produced.", report.note);
  return lines.join("\n");
}

export function parseDailyActivityArguments(argv) {
  const options = { json: false };
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--json") options.json = true;
    else if (["--input", "--start", "--end"].includes(argument)) {
      const value = argv[++index];
      if (!value || value.startsWith("--")) fail("argument_invalid");
      options[argument.slice(2)] = value;
    } else fail("argument_invalid");
  }
  if (!options.input || !options.start || !options.end) fail("arguments_required");
  return Object.freeze(options);
}

export async function readDailyActivity(path, options) {
  let input;
  try { input = JSON.parse(await readFile(path, "utf8")); } catch { fail("input_unreadable"); }
  return summarizeDailyActivity(input, options);
}

async function main() {
  const options = parseDailyActivityArguments(process.argv.slice(2));
  const report = await readDailyActivity(options.input, { start: options.start, end: options.end });
  console.log(options.json ? JSON.stringify(report, null, 2) : renderDailyActivity(report));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => { console.error(`public-daily-activity: ${error.message}`); process.exitCode = 1; });
