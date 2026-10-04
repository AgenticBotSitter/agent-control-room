import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { analyze, slope, p95, invariantFailures, csvRows, CSV_HEADER, summary, DEFAULT_LIMITS, STORAGE_BYTES_PER_CYCLE } from '../scripts/mac-local/rehearsal/soak-analysis.mjs';
const recorded = JSON.parse(readFileSync(new URL('./fixtures/soak-samples.json', import.meta.url)));
const samples = () => structuredClone(recorded);

test('OLS uses elapsed minutes, handles jitter, plateaus and declines', () => {
  assert.ok(Math.abs(slope([[0, 10], [2, 14], [5, 20]]) - 2) < 1e-12);
  assert.equal(slope([[0, 5], [1, 5], [4, 5]]), 0);
  assert.equal(slope([[0, 5], [1, 3], [2, 1]]), -2);
  for (const bad of [[], [[1, 2]], [[1, 2], [1, 3]], [[0, NaN], [1, 2]]]) assert.throws(() => slope(bad));
});
test('p95 is nearest rank, accepts zero, rejects absent or corrupt timings', () => {
  assert.equal(p95(Array.from({ length: 100 }, (_, i) => 100 - i)), 95);
  assert.equal(p95([0]), 0);
  for (const bad of [[], [NaN], [-1], [Infinity]]) assert.throws(() => p95(bad));
});
test('recorded stable samples and ordinary storage growth pass', () => {
  assert.equal(analyze(samples()).ok, true);
  const s = samples(); for (const row of s) { row.tableBytes = 10000 + row.cycles * STORAGE_BYTES_PER_CYCLE;
    row.indexBytes = 10000 + row.cycles * STORAGE_BYTES_PER_CYCLE; }
  assert.equal(analyze(s).ok, true);
  assert.match(summary(analyze(s)), /^PASS/);
});
for (const key of ['connections', 'tempFiles', 'deadTuples', 'tableBytes', 'indexBytes']) {
  test(`sustained ${key} growth fails and threshold equality passes`, () => {
    const s = samples();
    for (const row of s) row[key] = 100 + row.minute * (DEFAULT_LIMITS[key] + 1)
      + (['tableBytes', 'indexBytes'].includes(key) ? row.cycles * STORAGE_BYTES_PER_CYCLE : 0);
    assert.equal(analyze(s).ok, false);
    assert.ok(analyze(s).failures.some(f => f.includes(key)));
    for (const row of s) row[key] = 100 + row.minute * DEFAULT_LIMITS[key]
      + (['tableBytes', 'indexBytes'].includes(key) ? row.cycles * STORAGE_BYTES_PER_CYCLE : 0);
    assert.equal(analyze(s).ok, true);
  });
}
test('per-process handles growth fails', () => {
  const s = samples(); for (const row of s) row.processes[1].handles = 100 + row.minute * (DEFAULT_LIMITS.handles + 1);
  assert.equal(analyze(s).ok, false);
});
test('non-RSS warmup excludes startup handle allocation', () => {
  const s = samples(); s[0].processes[0].handles = 0; s[1].processes[0].handles = 500;
  assert.equal(analyze(s).ok, true);
});
test('latency over 2x fails, exactly 2x passes, zero baseline fails', () => {
  const s = samples(); for (const row of s) row.p95Ms = row.minute >= 8 ? 41 : 20;
  assert.equal(analyze(s).ok, false);
  for (const row of s) row.p95Ms = row.minute >= 8 ? 40 : 20;
  assert.equal(analyze(s).ok, true);
  for (const row of s) row.p95Ms = 0;
  assert.equal(analyze(s).ok, false);
});
for (const [label, change] of [
  ['duplicate claim', s => { s[3].duplicateJobs = 1; }],
  ['stuck running', s => { s[3].stuckRunning = 1; }],
  ['unfinished work at end', s => { s.at(-1).running = 1; }],
  ['restart', s => { s[3].processes[0].restarts = 1; }],
  ['exited process', s => { s[3].processes[0].alive = false; }],
  ['changed PID', s => { s[3].processes[0].pid = 99; }],
  ['same count wrong inbox', s => { s[3].inboxIds = ['wrong']; }],
  ['duplicate inbox entry', s => { s[3].inboxIds = ['job:review', 'job:review']; }],
  ['attention count', s => { s[3].attentionCount = 0; }],
]) test(`${label} fails even when all slopes are flat`, () => {
  const s = samples(); change(s); assert.equal(analyze(s).ok, false);
});
test('missing, reordered, reset, invalid and too-short observations fail closed', () => {
  for (const change of [s => s.splice(3), s => { s.at(-1).minute = 8; },
    s => { s[3].minute = 1; }, s => { s[3].minute = 3.5; }, s => { for (const row of s) row.cycles = 0; }, s => { s[3].cycles = 0; }, s => { s[3].connections = NaN; },
    s => { s[3].processes = []; }, s => { s[3].processes[0].handles = -1; }, s => { delete s[3].processes[0].pid; }, s => { s[3].processes[0].name = ""; }]) {
    const s = samples(); change(s); assert.equal(analyze(s).ok, false);
  }
  assert.equal(analyze([]).ok, false);
  assert.equal(analyze(samples(), { warmupMinutes: 9 }).ok, false);
  assert.equal(analyze(samples(), { limits: { ...DEFAULT_LIMITS, handles: NaN } }).ok, false);
});
test('checkpoint running work is allowed before the final sample', () => {
  const row = samples()[0]; row.running = 1;
  assert.deepEqual(invariantFailures(row), []);
  assert.equal(invariantFailures(row, true).length, 1);
});
test('CSV covers aggregate, process and relation observations with escaped names', () => {
  const row = samples()[0]; row.relations = [{ schemaname: 'public', relname: 'a,"b', tableBytes: 42, indexBytes: 9, deadTuples: 2 }];
  const csv = csvRows(row);
  assert.equal(CSV_HEADER.split(',').length, 21);
  for (const line of csv.trim().split('\n')) assert.equal(line.match(/"(?:[^"]|"")*"(?:,|$)/g).length, 21);
  assert.match(csv, /"public.a,""b"/);
  assert.match(csv, /"1001","50000000","24"/);
  assert.match(summary({ ok: false, failures: ['Broken.'] }), /FAIL.*\n- Broken\./);
});

test('each observation coverage check independently refuses incomplete evidence', () => {
  assert.equal(analyze(samples(), { durationMinutes: 12 }).ok, false);
  assert.equal(analyze(samples().slice(0, 7), { durationMinutes: 6, warmupMinutes: 0 }).ok, false);
  const unordered = samples(); for (const row of unordered) row.minute /= 2;
  unordered[4].minute = unordered[3].minute;
  assert.equal(analyze(unordered, { durationMinutes: 5, warmupMinutes: 0 }).ok, false);
  const idle = samples(); for (const row of idle) { row.cycles = 0; row.tableBytes = 100; row.indexBytes = 100; }
  assert.equal(analyze(idle).ok, false);
  const missingPids = samples(); for (const row of missingPids) row.processes[0].pid = 0;
  assert.equal(analyze(missingPids).ok, false);
});

const anchors = JSON.parse(readFileSync(new URL('./fixtures/soak-report-anchors.json', import.meta.url)));
function reportRun() {
  return Array.from({ length: anchors.observations }, (_, minute) => {
    const row = structuredClone(recorded[0]);
    Object.assign(row, { minute, cycles: Math.floor(minute * anchors.cycles / anchors.durationMinutes),
      p95Ms: anchors.latency.nonBurstMedianMs,
      burstInterval: anchors.latency.burstMinutes.includes(minute) });
    row.processes = anchors.processes.map((p, i) => {
      // Modeled startup allocation, plateau, GC at minute 23, then decline to
      // the measured endpoint. Only anchors come from the report.
      const peak = p.startMiB + 5;
      const rssMiB = minute <= 5 ? p.startMiB + minute : minute < anchors.gcMinute ? peak
        : peak - p.gcStepMiB + (p.endMiB - peak + p.gcStepMiB)
          * (minute - anchors.gcMinute) / (anchors.durationMinutes - anchors.gcMinute);
      return { name: p.name, pid: 1001 + i, rssBytes: rssMiB * 1024 ** 2, handles: 20, alive: true, restarts: 0 };
    });
    if (row.burstInterval) row.p95Ms = anchors.latency.burstMedianMs;
    if (minute === 2) row.p95Ms = anchors.latency.nonBurstBaselineMs;
    if (minute === 80) row.p95Ms = anchors.latency.nonBurstMaxMs;
    if (minute === 84) row.p95Ms = anchors.latency.burstMaxMs;
    if (minute === 178) row.p95Ms = anchors.latency.nonBurstTailMs;
    if (minute === 179) row.p95Ms = anchors.latency.burstTailMs;
    return row;
  });
}
const analyzeLong = rows => analyze(rows, { durationMinutes: rows.at(-1).minute });
const rssTrend = (result, name = 'harness') => result.trends.find(t => t.name === `${name}.rssBytes`);
test('report-derived three-hour fixture passes RSS and non-burst latency; burst latency is information', () => {
  const rows = reportRun(), result = analyzeLong(rows);
  assert.deepEqual(result.failures, []);
  assert.ok(result.trends.filter(t => t.name.endsWith('.rssBytes')).every(t => t.status === 'PASS' && t.perMinute < 0));
  assert.equal(result.latency.status, 'PASS');
  assert.equal(result.latency.baselineMs, 91.6);
  assert.equal(result.latency.tailMs, 127.7);
  assert.deepEqual(result.latency.burst, { intervals: 35, medianP95Ms: 92, maxP95Ms: 400 });
  assert.match(summary(result), /Burst-interval latency \(information\).*median p95 92 ms; max p95 400 ms/);
  for (const [i, p] of anchors.processes.entries())
    assert.equal(rows.at(-1).processes[i].rssBytes, p.endMiB * 1024 ** 2);
});
// Each supplied value is a bucket minimum in MiB; timestamps remain elapsed minutes.
function envelopeRun(minima) {
  const rows = reportRun().slice(0, 20 + minima.length * 5 + 1);
  for (const row of rows) row.processes[0].rssBytes = (row.minute < 20 ? 500
    : minima[Math.min(minima.length - 1, Math.floor((row.minute - 20) / 5))]) * 1024 ** 2;
  return rows;
}
test('RSS uses independent five-minute minima after minute twenty, excluding the partial tail', () => {
  const rows = reportRun().slice(0, 84);
  const troughs = new Map(Array.from({ length: 12 }, (_, i) => [21 + i * 5 + i % 2, 80 + i % 3]));
  for (const row of rows) row.processes[0].rssBytes = (row.minute < 20 || row.minute >= 80
    ? 0 : troughs.get(row.minute) ?? 1000) * 1024 ** 2;
  const result = analyzeLong(rows), rss = rssTrend(result);
  assert.deepEqual(rss.bucketMinima, [...troughs].map(([minute, mb]) => [minute, mb * 1024 ** 2]));
  assert.equal(rss.startMinute, 21);
  assert.equal(rss.endMinute, 77);
  assert.equal(rss.status, 'PASS');
  assert.notDeepEqual(rssTrend(result, 'web').bucketMinima, rss.bucketMinima);
  assert.equal(result.ok, true);
});
test('RSS bucket boundaries are half-open and a final boundary sample cannot add a bucket', () => {
  const rows = envelopeRun(Array.from({ length: 12 }, (_, i) => 100 + i));
  rows.at(-1).processes[0].rssBytes = 0;
  const rss = rssTrend(analyzeLong(rows));
  assert.deepEqual(rss.bucketMinima, Array.from({ length: 12 }, (_, i) => 20 + i * 5).map((m, i) => [m, (100 + i) * 1024 ** 2]));
  assert.equal(rss.bucketMinima.length, 12);
});
test('RSS fits actual minimum observation times under irregular sampling', () => {
  const rows = reportRun();
  for (const row of rows) {
    row.minute += row.minute % 2 ? 0.2 : 0;
    row.processes[0].rssBytes = 100 * 1024 ** 2 + row.minute * 300 * 1024;
  }
  const rss = rssTrend(analyzeLong(rows));
  assert.equal(rss.status, 'FAIL');
  assert.ok(Math.abs(rss.perMinute - 300 * 1024) < 1e-6);
  assert.deepEqual(rss.bucketMinima.slice(0, 4).map(p => p[0]), [20, 25.2, 30, 35.2]);
  assert.equal(rss.allowanceBytes, rss.limit * (rss.endMinute - rss.startMinute));
});
for (const name of anchors.processes.map(p => p.name)) test(`continuous ${name} RSS growth without a plateau fails`, () => {
  const rows = reportRun();
  for (const row of rows) row.processes.find(p => p.name === name).rssBytes = 100 * 1024 ** 2
    + row.minute * (DEFAULT_LIMITS.rssBytes + 1);
  const result = analyzeLong(rows), rss = rssTrend(result, name);
  assert.equal(rss.status, 'FAIL');
  assert.equal(rss.bucketMinima.length, 32);
  assert.deepEqual(result.failures, [`${name}.rssBytes grew faster than its allowed rate.`]);
});
test('steady 300 KiB/min leak after startup fails with rising bucket minima', () => {
  const rows = reportRun();
  for (const row of rows) row.processes[0].rssBytes = 100 * 1024 ** 2 + Math.max(0, row.minute - 10) * 300 * 1024;
  const result = analyzeLong(rows), rss = rssTrend(result);
  assert.equal(result.ok, false);
  assert.equal(rss.status, 'FAIL');
  assert.equal(rss.startMinute, 20);
  assert.equal(rss.perMinute, 300 * 1024);
  assert.ok(rss.riseBytes > rss.allowanceBytes);
  assert.deepEqual(result.failures, ['harness.rssBytes grew faster than its allowed rate.']);
});
test('excessive envelope slope alone passes when first-to-last minima stay within allowance', () => {
  for (const last of [113, 113.75]) {
    const rss = rssTrend(analyzeLong(envelopeRun([100, ...Array(5).fill(50), ...Array(5).fill(80), last])));
    assert.ok(rss.perMinute > rss.limit);
    assert.ok(rss.riseBytes <= rss.allowanceBytes);
    if (last === 113.75) assert.equal(rss.riseBytes, rss.allowanceBytes);
    assert.equal(rss.status, 'PASS');
  }
  const rss = rssTrend(analyzeLong(envelopeRun([100, ...Array(5).fill(50), ...Array(5).fill(80), 99])));
  assert.ok(rss.perMinute > rss.limit);
  assert.ok(rss.riseBytes < 0);
  assert.equal(rss.status, 'PASS');
});
test('excessive first-to-last minima rise alone passes when envelope slope stays within limit', () => {
  const rss = rssTrend(analyzeLong(envelopeRun([100, ...Array(10).fill(70), 114])));
  assert.ok(rss.riseBytes > rss.allowanceBytes);
  assert.ok(rss.perMinute < rss.limit);
  assert.equal(rss.status, 'PASS');
  const minima = Array.from({ length: 12 }, (_, i) => 100 + i * 1.25);
  // These deviations cancel in OLS while increasing the endpoint rise.
  minima[0] -= 9; minima[1] += 22; minima[11] += 9;
  const equal = rssTrend(analyzeLong(envelopeRun(minima)));
  assert.equal(equal.perMinute, equal.limit);
  assert.ok(equal.riseBytes > equal.allowanceBytes);
  assert.equal(equal.status, 'PASS');
});
test('RSS threshold equality passes and excess above both conditions fails', () => {
  for (const rate of [256, 256.001]) {
    const rows = reportRun();
    for (const row of rows) row.processes[0].rssBytes = 100 * 1024 ** 2 + row.minute * rate * 1024;
    assert.equal(rssTrend(analyzeLong(rows)).status, rate === 256 ? 'PASS' : 'FAIL');
  }
});
test('RSS is unjudged only below twelve complete buckets, including a ten-minute run', () => {
  for (const duration of [10, 19, 20, 30, 74, 75, 79]) {
    const result = analyzeLong(reportRun().slice(0, duration + 1));
    assert.equal(result.ok, true);
    assert.ok(result.trends.filter(t => t.name.endsWith('.rssBytes')).every(t =>
      t.status === 'not judged (run too short)' && t.perMinute === undefined && t.bucketMinima.length < 12));
    assert.match(summary(result), /Memory was NOT judged .*no leak verdict/);
    assert.match(summary(result), /rssBytes: not judged \(run too short\)/);
    assert.doesNotMatch(summary(result), /rssBytes: (PASS|FAIL)/);
  }
  for (const duration of [80, 85, 180]) {
    const rss = rssTrend(analyzeLong(reportRun().slice(0, duration + 1)));
    assert.equal(rss.status, 'PASS');
    assert.equal(rss.bucketMinima.length, (duration - 20) / 5);
  }
});
test('invalid RSS allowance fails even when the run is too short to judge RSS', () => {
  for (const limit of [NaN, Infinity, -1])
    assert.equal(analyze(samples(), { limits: { ...DEFAULT_LIMITS, rssBytes: limit } }).ok, false);
});
test('synthetic latency decay in non-burst intervals still fails', () => {
  const rows = reportRun();
  for (const row of rows) if (!row.burstInterval && row.minute >= 170) row.p95Ms = 200;
  const result = analyzeLong(rows);
  assert.equal(result.ok, false);
  assert.equal(result.latency.status, 'FAIL');
  assert.deepEqual(result.failures, ['Request latency exceeded twice its baseline.']);
});
test('missing or malformed burst tags fail; insufficient non-burst evidence fails instead of passing', () => {
  for (const value of [undefined, null, 0, 'false']) {
    const rows = samples(); rows[3].burstInterval = value;
    assert.deepEqual(analyze(rows).failures, ['Samples are missing, invalid or out of order.']);
  }
  const rows = samples(); for (const row of rows) row.burstInterval = true;
  const result = analyze(rows);
  assert.equal(result.ok, false);
  assert.deepEqual(result.failures, ['Too few non-burst latency intervals after warmup.']);
  assert.equal(result.latency.burst.intervals, 11);
});
test('CSV saves the source burst tag only on the aggregate interval row', () => {
  const row = samples()[0]; row.burstInterval = true;
  const lines = csvRows(row).trim().split('\n');
  assert.equal(CSV_HEADER.split(',').at(-1), 'burst_interval');
  assert.match(lines[0], /,"true"$/);
  assert.match(lines[1], /,""$/);
});

test('burst information handles empty and even sets; exactly six ordinary intervals can be judged', () => {
  const rows = samples();
  assert.deepEqual(analyze(rows).latency.burst, { intervals: 0, medianP95Ms: null, maxP95Ms: null });
  rows[0].burstInterval = true; rows[0].p95Ms = 100;
  rows[1].burstInterval = true; rows[1].p95Ms = 200;
  assert.deepEqual(analyze(rows).latency.burst, { intervals: 2, medianP95Ms: 150, maxP95Ms: 200 });
  for (const row of rows) if (row.minute >= 2 && row.minute <= 4) row.burstInterval = true;
  const result = analyze(rows);
  assert.equal(result.ok, true);
  assert.equal(result.latency.nonBurstIntervals, 6);
  assert.equal(result.latency.status, 'PASS');
});

const realRuns = JSON.parse(readFileSync(new URL('./fixtures/soak-recorded-runs.json', import.meta.url)));
const realRun = name => structuredClone(realRuns[name].samples);
test('actual recorded thirty-minute run passes wiring checks with every RSS process unjudged', () => {
  const result = analyzeLong(realRun('thirtyMinute'));
  assert.deepEqual(result.failures, []);
  assert.ok(result.trends.filter(t => t.name.endsWith('.rssBytes')).every(t => t.status === 'not judged (run too short)' && t.perMinute === undefined && t.bucketMinima.length === 2));
});
test('actual recorded three-hour run passes RSS and preserves measured source-derived latency', () => {
  const result = analyzeLong(realRun('threeHour'));
  assert.deepEqual(result.failures, []);
  assert.ok(result.trends.filter(t => t.name.endsWith('.rssBytes')).every(t => t.status === 'PASS' && t.bucketMinima.length === 32));
  assert.ok(Math.abs(result.latency.baselineMs - 91.63058300000639) < 0.01);
  assert.ok(Math.abs(result.latency.tailMs - 127.72762400005013) < 0.01);
  assert.equal(result.latency.burst.intervals, 83);
});
for (const [label, bytes] of [
  ['300 KiB/min from minute zero', m => 100 * 1024 ** 2 + m * 300 * 1024],
  ['1000 KiB/min from minute zero', m => 100 * 1024 ** 2 + m * 1000 * 1024],
  ['two percent per minute geometric', m => 100 * 1024 ** 2 * 1.02 ** m],
  ['300 KiB/min from minute twenty', m => 100 * 1024 ** 2 + Math.max(0, m - 20) * 300 * 1024],
  ['10 MiB steps every five minutes', m => 100 * 1024 ** 2 + Math.floor(m / 5) * 10 * 1024 ** 2],
]) test(`actual three-hour replay with ${label} fails`, () => {
  const rows = realRun('threeHour');
  for (const row of rows) row.processes.find(p => p.name === 'harness').rssBytes = bytes(row.minute);
  const result = analyzeLong(rows), rss = rssTrend(result);
  assert.equal(rss.status, 'FAIL');
  assert.equal(rss.bucketMinima.length, 32);
  assert.deepEqual(result.failures, ['harness.rssBytes grew faster than its allowed rate.']);
});
for (const name of ['thirtyMinute', 'threeHour']) test(`actual ${name} RSS verdict never changes PASS to FAIL when start slides zero to five minutes`, () => {
  const failures = [];
  for (let tick = 0; tick <= 500; tick++) {
    const offset = tick / 100, rows = realRun(name).filter(row => row.minute >= offset);
    for (const row of rows) row.minute -= offset;
    const rss = analyzeLong(rows).trends.filter(t => t.name.endsWith('.rssBytes'));
    assert.equal(rss.length, 6);
    const expected = name === 'threeHour' ? 'PASS' : 'not judged (run too short)';
    for (const trend of rss) if (trend.status !== expected) failures.push({ offset, name: trend.name, status: trend.status });
  }
  assert.deepEqual(failures, []);
});
test('five ordinary latency intervals still fail and a clean retry passes', () => {
  const rows = samples();
  for (const row of rows) row.burstInterval = row.minute >= 2 && row.minute <= 5;
  const result = analyze(rows);
  assert.equal(result.latency.nonBurstIntervals, 5);
  assert.deepEqual(result.failures, ['Too few non-burst latency intervals after warmup.']);
  assert.equal(analyze(samples()).ok, true);
});
