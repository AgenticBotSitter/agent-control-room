// Pure analysis: minutes are elapsed monotonic time, bytes are bytes, never wall-clock dates.
export const DEFAULT_LIMITS = Object.freeze({ rssBytes: 256 * 1024, handles: 0.1, connections: 0.05,
  tempFiles: 0.1, deadTuples: 20, tableBytes: 64 * 1024, indexBytes: 64 * 1024 });
export const STORAGE_BYTES_PER_CYCLE = 256 * 1024;

export function slope(points) {
  if (points.length < 2 || points.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y)))
    throw new Error('soak_invalid_points');
  const mx = points.reduce((n, p) => n + p[0], 0) / points.length;
  const my = points.reduce((n, p) => n + p[1], 0) / points.length;
  const denominator = points.reduce((n, p) => n + (p[0] - mx) ** 2, 0);
  if (!denominator) throw new Error('soak_no_elapsed_time');
  return points.reduce((n, p) => n + (p[0] - mx) * (p[1] - my), 0) / denominator;
}
export function p95(values) {
  if (!values.length || values.some(x => !Number.isFinite(x) || x < 0)) throw new Error('soak_missing_latency');
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
}
const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length
  && new Set(a).size === a.length && JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
export function invariantFailures(sample, final = false) {
  const failures = [];
  if (!same(sample.inboxIds, sample.truthInboxIds) || sample.attentionCount !== sample.truthInboxIds?.length)
    failures.push('The inbox and its attention count disagree with saved work.');
  if (sample.duplicateJobs !== 0) failures.push('A task was claimed more than once.');
  if (sample.stuckRunning !== 0 || final && sample.running !== 0) failures.push('Work remained running beyond its deadline.');
  if (sample.processes?.some(p => p.restarts !== 0 || p.alive !== true)) failures.push('A process exited or restarted.');
  return failures;
}
export function analyze(samples, { durationMinutes = 10, warmupMinutes = 2, limits = DEFAULT_LIMITS } = {}) {
  const failures = [];
  if (samples.length < 8 || samples.at(-1)?.minute < durationMinutes - 0.05 || samples.at(-1)?.cycles === 0) failures.push('The observation window is incomplete.');
  const numeric = ['minute', 'cycles', 'connections', 'tempFiles', 'deadTuples', 'tableBytes', 'indexBytes',
    'attentionCount', 'duplicateJobs', 'stuckRunning', 'running', 'p95Ms'];
  const names = samples[0]?.processes?.map(p => p.name).sort().join(',');
  const valid = samples.every((s, i) => numeric.every(k => Number.isFinite(s[k]) && s[k] >= 0)
    && (!i || s.minute > samples[i - 1].minute && s.minute - samples[i - 1].minute <= 1.25 && s.cycles >= samples[i - 1].cycles)
    && typeof s.burstInterval === 'boolean'
    && s.processes?.length > 0 && s.processes.map(p => p.name).sort().join(',') === names
    && new Set(s.processes.map(p => p.name)).size === s.processes.length
    && s.processes.every(p => typeof p.name === 'string' && p.name.length > 0 && Number.isSafeInteger(p.pid) && p.pid > 1
      && Number.isFinite(p.rssBytes) && p.rssBytes >= 0 && Number.isFinite(p.handles) && p.handles >= 0));
  if (!valid) return { ok: false, failures: ['Samples are missing, invalid or out of order.'], trends: [] };
  for (const [i, s] of samples.entries()) failures.push(...invariantFailures(s, i === samples.length - 1));
  const window = samples.filter(s => s.minute >= warmupMinutes);
  const trends = [];
  function check(name, key, values) {
    if (values.length < 6) { failures.push('Too few samples after warmup.'); return; }
    const fitted = slope(values);
    trends.push({ name, perMinute: fitted, limit: limits[key] });
    if (!Number.isFinite(limits[key]) || fitted > limits[key] + 1e-9 * Math.max(1, Math.abs(limits[key]))) failures.push(`${name} grew faster than its allowed rate.`);
  }
  for (const process of samples[0]?.processes ?? []) {
    const rss = samples.map(s => [s.minute, s.processes.find(p => p.name === process.name).rssBytes]);
    const limit = limits.rssBytes;
    // The lower envelope uses only complete [start, end) five-minute buckets
    // after minute twenty. Retain each minimum's actual elapsed observation time.
    const buckets = new Map();
    for (const point of rss) {
      const [minute, bytes] = point;
      if (minute < 20) continue;
      const index = Math.floor((minute - 20) / 5);
      if (20 + (index + 1) * 5 > rss.at(-1)[0]) continue;
      if (!buckets.has(index) || bytes < buckets.get(index)[1]) buckets.set(index, point);
    }
    const fit = [...buckets.values()];
    const trend = { name: `${process.name}.rssBytes`, limit, bucketMinima: fit,
      status: 'not judged (run too short)' };
    if (!Number.isFinite(limit) || limit < 0) {
      trend.status = 'FAIL'; failures.push('RSS has an invalid allowed rate.');
    } else if (fit.length >= 12) {
      const perMinute = slope(fit), riseBytes = fit.at(-1)[1] - fit[0][1];
      const allowanceBytes = limit * (fit.at(-1)[0] - fit[0][0]);
      const tolerance = 1e-9 * Math.max(1, limit);
      const failed = perMinute > limit + tolerance
        && riseBytes > allowanceBytes + tolerance * (fit.at(-1)[0] - fit[0][0]);
      Object.assign(trend, { status: failed ? 'FAIL' : 'PASS', perMinute, startMinute: fit[0][0],
        endMinute: fit.at(-1)[0], riseBytes, allowanceBytes });
      if (failed) failures.push(`${process.name}.rssBytes grew faster than its allowed rate.`);
    }
    trends.push(trend);
    check(`${process.name}.handles`, 'handles',
      window.map(s => [s.minute, s.processes.find(p => p.name === process.name).handles]));
    if (samples.some(s => s.processes.find(p => p.name === process.name).pid !== process.pid))
      failures.push('A process identity changed.');
  }
  for (const key of ['connections', 'tempFiles', 'deadTuples', 'tableBytes', 'indexBytes'])
    check(key, key, window.map(s => [s.minute, s[key] - (['tableBytes', 'indexBytes'].includes(key)
      ? s.cycles * STORAGE_BYTES_PER_CYCLE : 0)]));
  const ordinary = window.filter(s => !s.burstInterval);
  const burstValues = samples.filter(s => s.burstInterval).map(s => s.p95Ms).sort((a, b) => a - b);
  const middle = Math.floor(burstValues.length / 2);
  const latency = { status: 'FAIL', nonBurstIntervals: ordinary.length, burst: { intervals: burstValues.length,
    medianP95Ms: burstValues.length ? (burstValues[middle] + burstValues[Math.floor((burstValues.length - 1) / 2)]) / 2 : null,
    maxP95Ms: burstValues.at(-1) ?? null } };
  if (ordinary.length < 6) failures.push('Too few non-burst latency intervals after warmup.');
  else {
    latency.baselineMs = p95(ordinary.slice(0, 3).map(s => s.p95Ms));
    latency.tailMs = p95(ordinary.slice(-3).map(s => s.p95Ms));
    if (latency.baselineMs <= 0 || latency.tailMs > 2 * latency.baselineMs)
      failures.push('Request latency exceeded twice its baseline.');
    else latency.status = 'PASS';
  }
  return { ok: failures.length === 0, failures: [...new Set(failures)], trends, latency };
}
export const CSV_HEADER = 'minute,kind,name,pid,rss_bytes,open_handles,connections,table_bytes,index_bytes,dead_tuples,temp_files,attention_count,truth_count,p95_ms,cycles,duplicate_jobs,stuck_running,running,restarts,alive,burst_interval';
export function csvRows(s) {
  const cell = value => `"${String(value ?? '').replaceAll('"', '""')}"`;
  const row = values => [...values, ...Array(Math.max(0, CSV_HEADER.split(',').length - values.length)).fill('')].map(cell).join(',');
  return [row([s.minute, 'stack', '', '', '', '', s.connections, s.tableBytes, s.indexBytes, s.deadTuples,
    s.tempFiles, s.attentionCount, s.truthInboxIds.length, s.p95Ms, s.cycles, s.duplicateJobs, s.stuckRunning, s.running, '', '', s.burstInterval]),
  ...[...s.processes, ...(s.auxiliaryProcesses ?? [])].map(p => row([s.minute, 'process', p.name, p.pid, p.rssBytes, p.handles,
    '', '', '', '', '', '', '', '', '', '', '', '', p.restarts, p.alive])),
  ...(s.relations ?? []).map(r => row([s.minute, 'relation', `${r.schemaname}.${r.relname}`, '', '', '', '',
    r.tableBytes, r.indexBytes, r.deadTuples]))].join('\n') + '\n';
}
export function summary(result) {
  return `${result.ok ? 'PASS: judged checks passed; see individual RSS judgments below.'
    : 'FAIL: this soak did not pass.'}\n${result.failures.map(s => `- ${s}`).join('\n')}\n`
    + ((result.trends ?? []).some(t => t.name.endsWith('.rssBytes') && t.status === 'not judged (run too short)')
      ? 'Memory was NOT judged (run too short); this result gives no leak verdict.\n' : '')
    + (result.trends ?? []).filter(t => t.name.endsWith('.rssBytes')).map(t => `${t.name}: ${t.status}\n`).join('')
    + (result.latency ? `Non-burst latency: ${result.latency.status}; baseline ${result.latency.baselineMs ?? 'unavailable'} ms; tail ${result.latency.tailMs ?? 'unavailable'} ms.\n`
      + `Burst-interval latency (information): ${result.latency.burst.intervals} intervals; median p95 ${result.latency.burst.medianP95Ms ?? 'unavailable'} ms; max p95 ${result.latency.burst.maxP95Ms ?? 'unavailable'} ms.\n` : '')
    + 'A finite soak cannot prove that growth is bounded forever. See the documented thresholds and CSV.\n';
}
