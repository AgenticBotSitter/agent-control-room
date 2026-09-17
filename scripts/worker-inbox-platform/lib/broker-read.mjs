// Source-only private transport. No credential discovery or live activation.
import { createHash } from "node:crypto";

export const BROKER_VERSION = "acr-worker-broker-operations:v1";
export function brokerConfiguration({ url, environment = process.env } = {}) {
  const endpoint = url ?? environment.ACR_WORKER_BROKER_URL;
  if (!endpoint) return undefined;
  let parsed;
  try { parsed = new URL(endpoint); } catch { throw new Error("worker_inbox_broker_configuration_invalid"); }
  if ((parsed.protocol !== "https:" && !(parsed.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)))
    || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== "/v1/worker-operations") {
    throw new Error("worker_inbox_broker_configuration_invalid");
  }
  const token = environment.ACR_WORKER_BROKER_TOKEN;
  if (typeof token !== "string" || !token.trim() || /[\r\n]/.test(token)) throw new Error("worker_inbox_broker_configuration_invalid");
  return { url: parsed.href, token: token.trim() };
}

// Mutable scheduling data contains only times/counters. The platform watcher persists
// it alongside (not inside) the last successful observation so restarts obey backoff.
export async function brokerSnapshot({ broker, workerId, repository, includeReady, fetchImpl,
  state, now = Date.now }) {
  const at = now();
  if (state.nextBrokerAt > at) throw new Error("worker_inbox_broker_deferred");
  const operation = includeReady ? "ready-queue-discovery" : "worker-inbox-read";
  let response;
  try {
    response = await fetchImpl(broker.url, { method: "POST", redirect: "error",
      signal: AbortSignal.timeout(10000), headers: { "content-type": "application/json", authorization: `Bearer ${broker.token}` },
      body: JSON.stringify({ operation, workerId }) });
    if (!response.ok) throw new Error("unavailable");
    const text = await response.text();
    if (Buffer.byteLength(text) > 4 * 1024 * 1024) throw new Error("oversized");
    const result = JSON.parse(text);
    const snapshot = result.snapshot;
    if (result.version !== BROKER_VERSION || result.operation !== operation || result.ok !== true
      || result.workerId !== workerId || snapshot?.repository !== repository || snapshot.complete !== true
      || !Array.isArray(snapshot.issues) || snapshot.issues.length > 60
      || !snapshot.comments || !snapshot.commentErrors || Object.keys(snapshot.commentErrors).length) throw new Error("invalid");
    for (const issue of snapshot.issues) {
      if (!Number.isSafeInteger(issue.number) || issue.number < 1 || !Array.isArray(issue.labels)
        || !Array.isArray(snapshot.comments[issue.number])) throw new Error("invalid");
    }
    if (includeReady && !/^[a-f0-9]{40}$/.test(snapshot.base?.sha ?? "")) throw new Error("invalid");
    state.failures = 0;
    delete state.nextBrokerAt;
    delete state.nextFallbackAt;
    return snapshot;
  } catch {
    const failures = Math.min(6, (state.failures ?? 0) + 1);
    const stagger = 1000 + createHash("sha256").update(`${repository}:${workerId}`).digest().readUInt16BE(0) % 5000;
    const retry = response?.headers?.get?.("retry-after");
    const retryMs = retry && /^\d+$/.test(retry) ? Number(retry) * 1000
      : retry ? Math.max(0, Date.parse(retry) - at) : 0;
    // Never retry earlier than Retry-After, even when it exceeds the local cap.
    const delay = Math.max(60000 * 2 ** (failures - 1) + stagger, Number.isFinite(retryMs) ? retryMs : 0);
    state.failures = failures;
    state.nextBrokerAt = at + delay;
    // Schedule the first fallback, retain an already-due fallback across failures.
    state.nextFallbackAt ??= at + delay;
    throw new Error("worker_inbox_broker_unavailable");
  }
}

// Translate the bounded broker projection back into the accepted inbox parser's
// read seam. This adapter has no network access and cannot act as an arbitrary proxy.
export function snapshotFetch(snapshot, repository) {
  const root = `/repos/${repository}`;
  const issues = snapshot.issues.map(issue => ({ ...issue,
    ...(issue.isPullRequest ? { pull_request: {} } : {}),
    html_url: `https://github.com/${repository}/issues/${issue.number}` }));
  return async input => {
    const url = new URL(input);
    if (url.origin !== "https://api.github.com" || !url.pathname.startsWith(`${root}/`)) throw new Error("worker_inbox_broker_snapshot_invalid");
    const path = url.pathname.slice(root.length);
    let value;
    const comments = /^\/issues\/(\d+)\/comments$/.exec(path);
    const single = /^\/issues\/(\d+)$/.exec(path);
    if (path === "/issues") {
      value = issues.filter(issue => !url.searchParams.has("labels") || issue.labels.includes(url.searchParams.get("labels")));
    } else if (comments) {
      value = snapshot.comments[comments[1]]?.map(comment => ({ ...comment,
        user: { login: comment.author, type: comment.bot ? "Bot" : "User" },
        html_url: `https://github.com/${repository}/issues/${comments[1]}#issuecomment-${comment.id}` }));
    } else if (single) value = snapshot.dependencies?.[single[1]] ?? issues.find(issue => issue.number === Number(single[1]));
    else if (path === "/git/ref/heads/main") value = { object: { sha: snapshot.base?.sha } };
    if (value === undefined) throw new Error("worker_inbox_broker_snapshot_incomplete");
    if (Array.isArray(value)) {
      const page = Number(url.searchParams.get("page") ?? 1);
      value = value.slice((page - 1) * 100, page * 100);
    }
    return { ok: true, json: async () => value };
  };
}
