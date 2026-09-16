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
