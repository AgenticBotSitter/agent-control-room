import assert from "node:assert/strict";
import { generateKeyPairSync, createHmac, createVerify } from "node:crypto";
import test from "node:test";

import {
  GitHubAppInstallationAuth,
  InMemoryGitHubWebhookReplayStore,
  admitGitHubWorkerWebhook,
  createGitHubAppJwt,
} from "../src/github-app/v1";

const NOW = Date.parse("2026-09-15T06:00:00.000Z");
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const credentials = { appId: "4960037", installationId: "162066346", privateKeyPem };

test("app JWT is short-lived, backdated, and signed by the configured key", () => {
  const jwt = createGitHubAppJwt(credentials, NOW);
  const [header, payload, signature] = jwt.split(".");
  assert.equal(JSON.parse(Buffer.from(header, "base64url").toString()).alg, "RS256");
  const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
  assert.deepEqual(claims, { iat: Math.floor(NOW / 1000) - 60, exp: Math.floor(NOW / 1000) + 540, iss: "4960037" });
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${header}.${payload}`);
  verifier.end();
  assert.equal(verifier.verify(publicKey, signature, "base64url"), true);
});

test("installation token exchange is coalesced, cached, and never returns the app JWT", async () => {
  const requests: Array<{ input: string; init?: RequestInit }> = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input: String(input), init });
    await gate;
    return new Response(JSON.stringify({ token: "installation-token-that-is-secret", expires_at: "2026-09-15T07:00:00.000Z" }), {
      status: 201, headers: { "content-type": "application/json" },
    });
  };
  const auth = new GitHubAppInstallationAuth({ credentials, fetchImpl, now: () => NOW });
  const first = auth.token();
  const second = auth.token();
  release();
  assert.equal((await first).token, "installation-token-that-is-secret");
  assert.strictEqual(await second, await first);
  assert.strictEqual(await auth.token(), await first);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].input, "https://api.github.com/app/installations/162066346/access_tokens");
  assert.match(String((requests[0].init?.headers as Record<string, string>).authorization), /^Bearer [^.]+\.[^.]+\.[^.]+$/u);
  assert.doesNotMatch(JSON.stringify(requests), /installation-token-that-is-secret/u);
});

const SECRET = "a-long-disposable-webhook-secret-value";
const webhookBody = (overrides: Record<string, unknown> = {}) => Buffer.from(JSON.stringify({
  action: "created",
  repository: { full_name: "AgenticBotSitter/agent-control-room" },
  installation: { id: 162066346 },
  issue: { number: 300 },
  ...overrides,
}));
const signature = (body: Buffer) => `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;

function request(body: Buffer, id = "delivery-12345678", replayStore = new InMemoryGitHubWebhookReplayStore()) {
  return {
    body,
    headers: {
      "x-hub-signature-256": signature(body),
      "x-github-delivery": id,
      "x-github-event": "issue_comment",
    },
    secret: SECRET,
    expectedRepository: "AgenticBotSitter/agent-control-room",
    expectedInstallationId: 162066346,
    replayStore,
    nowMs: NOW,
  };
}

test("webhook admission verifies signature, installation, repository, event, action, and replay", async () => {
  const body = webhookBody();
  const acceptedRequest = request(body);
  const accepted = await admitGitHubWorkerWebhook(acceptedRequest);
  assert.deepEqual(accepted, { accepted: true, event: {
    deliveryId: "delivery-12345678", event: "issue_comment", action: "created",
    repository: "AgenticBotSitter/agent-control-room", installationId: 162066346, issueOrPullNumber: 300,
  } });
  assert.deepEqual(await admitGitHubWorkerWebhook(acceptedRequest), { accepted: false, reason: "delivery_replayed" });

  const badSignature = request(body, "delivery-22345678");
  badSignature.headers["x-hub-signature-256"] = `sha256=${"0".repeat(64)}`;
  assert.deepEqual(await admitGitHubWorkerWebhook(badSignature), { accepted: false, reason: "signature_invalid" });
  assert.deepEqual(await admitGitHubWorkerWebhook(request(webhookBody({ installation: { id: 9 } }), "delivery-32345678")),
    { accepted: false, reason: "installation_not_allowed" });
  assert.deepEqual(await admitGitHubWorkerWebhook(request(webhookBody({ repository: { full_name: "other/repo" } }), "delivery-42345678")),
    { accepted: false, reason: "repository_not_allowed" });
  assert.deepEqual(await admitGitHubWorkerWebhook(request(webhookBody({ action: "transferred" }), "delivery-52345678")),
    { accepted: false, reason: "action_not_allowed" });
});

test("changing only the unsigned delivery header cannot replay a captured signed body", async () => {
  const body = webhookBody();
  const store = new InMemoryGitHubWebhookReplayStore();
  assert.equal((await admitGitHubWorkerWebhook(request(body, "delivery-62345678", store))).accepted, true);
  assert.deepEqual(await admitGitHubWorkerWebhook(request(body, "delivery-72345678", store)),
    { accepted: false, reason: "delivery_replayed" });
});

test("the replay adapter fails closed at capacity instead of evicting a live record", async () => {
  const store = new InMemoryGitHubWebhookReplayStore({ maxEntries: 2 });
  const first = request(webhookBody(), "delivery-82345678", store);
  assert.equal((await admitGitHubWorkerWebhook(first)).accepted, true);
  await assert.rejects(
    admitGitHubWorkerWebhook(request(webhookBody({ issue: { number: 301 } }), "delivery-92345678", store)),
    /github_webhook_replay_store_full/u,
  );
  assert.deepEqual(await admitGitHubWorkerWebhook(first), { accepted: false, reason: "delivery_replayed" });
});

test("oversized webhook payload is rejected before parsing", async () => {
  const body = webhookBody({ padding: "x".repeat(100) });
  assert.deepEqual(await admitGitHubWorkerWebhook({ ...request(body), maxBodyBytes: 50 }),
    { accepted: false, reason: "payload_too_large" });
});

const tokenResponse = (name: string) => Response.json({ token: name.repeat(24), expires_at: "2026-09-15T07:00:00.000Z" });

for (const order of ["old-first", "new-first"] as const) test(`R5I-02: clear detaches a blocked exchange (${order})`, async () => {
  const releases: (() => void)[] = [];
  const auth = new GitHubAppInstallationAuth({ credentials, now: () => NOW,
    fetchImpl: async () => {
      const index = releases.length;
      await new Promise<void>(resolve => releases.push(resolve));
      return tokenResponse(index === 0 ? "old" : "new");
    } });
  const old = auth.token();
  auth.clear();
  const fresh = auth.token();
  try {
    assert.equal(releases.length, 2, "post-clear caller starts its own exchange");
    if (order === "old-first") {
      releases[0]!(); await old;
      const joined = auth.token();
      assert.equal(releases.length, 2, "old completion neither caches nor clears the fresh exchange");
      releases[1]!();
      assert.strictEqual(await joined, await fresh);
    } else {
      releases[1]!(); await fresh;
      releases[0]!(); await old;
    }
    assert.equal((await auth.token()).token, "new".repeat(24), "invalidated result cannot overwrite the cache");
  } finally {
    releases.forEach(release => release());
    await Promise.allSettled([old, fresh]);
  }
});

for (const phase of ["connection", "body"] as const) test(`R5I-03: 50 callers time out a stalled ${phase} and retry`, async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let release!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let signal: AbortSignal | null | undefined;
  const auth = new GitHubAppInstallationAuth({ credentials, now: () => NOW,
    fetchImpl: async (_input, init) => {
      calls++; signal = init?.signal;
      if (calls > 1) return tokenResponse("recovered");
      if (phase === "connection") { await gate; return tokenResponse("late"); }
      return { ok: true, json: async () => { await gate; return { token: "late".repeat(24), expires_at: "2026-09-15T07:00:00.000Z" }; } } as Response;
    } });
  let results: PromiseSettledResult<unknown>[] = [];
  const callers = Promise.allSettled(Array.from({ length: 50 }, () => auth.token())).then(value => { results = value; });
  const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
  try {
    await flush();
    assert.equal(calls, 1);
    assert.ok(signal instanceof AbortSignal, "fetch gets an owned abort signal");
    t.mock.timers.tick(19_999); await flush();
    assert.equal(results.length, 0, "deadline has not arrived");
    t.mock.timers.tick(1); await flush();
    assert.equal(results.length, 50, "even an abort-ignoring transport/body must settle");
    for (const result of results) {
      assert.equal(result.status, "rejected");
      if (result.status === "rejected") assert.match(String(result.reason), /github_app_token_exchange_timeout/);
    }
    assert.equal(signal!.aborted, true);
    assert.equal((await auth.token()).token, "recovered".repeat(24));
    assert.equal(calls, 2);
    release(); await flush();
    assert.equal((await auth.token()).token, "recovered".repeat(24), "late result cannot replace recovered cache");
  } finally { release(); await callers; t.mock.timers.reset(); }
});

test("R5I-03: successful and failed exchanges dispose their deadline before retry", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const signals: AbortSignal[] = [];
  let fail = true;
  const auth = new GitHubAppInstallationAuth({ credentials, now: () => NOW,
    fetchImpl: async (_input, init) => {
      signals.push(init!.signal!);
      return fail ? Response.json(null) : tokenResponse("valid");
    } });
  try {
    const failures = await Promise.allSettled(Array.from({ length: 50 }, () => auth.token()));
    assert.ok(failures.every(result => result.status === "rejected" && /github_app_token_response_invalid/.test(String(result.reason))));
    fail = false;
    await auth.token();
    t.mock.timers.tick(20_000);
    assert.equal(signals.length, 2);
    assert.ok(signals.every(signal => !signal.aborted), "completed requests have no live deadline");
  } finally { t.mock.timers.reset(); }
});

for (const body of [{ token: "short", expires_at: "2026-09-15T07:00:00.000Z" },
  { token: "x".repeat(24), expires_at: "invalid" }, { token: "x".repeat(24), expires_at: new Date(NOW).toISOString() }]) {
  test(`token response with invalid material is refused and can retry (${body.expires_at}/${body.token.length})`, async () => {
    let calls = 0;
    const auth = new GitHubAppInstallationAuth({ credentials, now: () => NOW,
      fetchImpl: async () => ++calls === 1 ? Response.json(body) : tokenResponse("valid") });
    await assert.rejects(auth.token(), /github_app_token_response_invalid/);
    assert.equal((await auth.token()).token, "valid".repeat(24));
  });
}
