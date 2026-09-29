import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Digest } from "../src/security";
import { OWNER_TRUSTED_LOCAL_ENABLEMENT_V1 } from "../src/harness/v1/owner-trusted-local-enablements";
import { LOCAL_OWNER_SESSION_PROFILE_V1 } from "../src/web/v1/local-owner-session";
import { MAC_LOCAL_PROTECTED_CONFIGURATION_V1 } from "../src/web/v1/mac-local-protected-configuration";
import { loadMacLocalProtectedConfigurationFromRootV1 } from "../src/web/v1/mac-local-protected-loader";
import { MAC_LOCAL_REMOTE_ACCESS_V1 } from "../src/web/v1/mac-local-remote-access";
import { checkRemoteAccess, parseRemoteAccessArguments, remoteAccessPlan, renderCloudflaredConfig,
  writeCloudflaredConfig } from "../scripts/mac-local/remote-access";

const tailnetOrigin = "https://control-room-mac.example-tailnet.ts.net";
const cloudflareOrigin = "https://private-app.example.invalid";
const audience = "c".repeat(64);
const tunnelId = "0f0e0d0c-0b0a-4090-8070-605040302010";

async function protectedRoot(remoteAccess?: unknown) {
  const root = await mkdtemp(join(tmpdir(), "control-room-remote-access-"));
  await chmod(root, 0o700); await mkdir(join(root, "config"), { mode: 0o700 });
  const file = join(root, "config", "mac-local.json");
  await writeFile(file, JSON.stringify({ schema: MAC_LOCAL_PROTECTED_CONFIGURATION_V1, port: 3210, workspaceId: "workspace:mac-local",
    localOwnerSession: { schema: LOCAL_OWNER_SESSION_PROFILE_V1, origin: "http://127.0.0.1:3210", tenantId: "tenant:mac-local",
      provider: "local-owner", subject: "owner:local", ownerCodeDigest: sha256Digest({ ownerCode: "x".repeat(24) }), sessionSeconds: 900 },
    database: { host: "127.0.0.1", port: 5432, database: "control_room", username: "control_room_web", password: "synthetic", majorVersion: 17 },
    enablement: { schema: OWNER_TRUSTED_LOCAL_ENABLEMENT_V1, mode: "mac-local", nodeId: "mac-1", workers: [{ workerId: "worker:codex",
      kind: "codex", executablePath: "/Applications/Codex.app/Contents/MacOS/codex", recordedVersion: "codex test" }] },
    ...(remoteAccess ? { remoteAccess } : {}) }), { mode: 0o600 });
  return root;
}

const both = { schema: MAC_LOCAL_REMOTE_ACCESS_V1, tailscale: { origin: tailnetOrigin },
  cloudflare: { origin: cloudflareOrigin, teamDomain: "https://example-team.cloudflareaccess.com", audience, ownerEmail: "owner@example.invalid" } };

test("argument parsing is exact", () => {
  assert.deepEqual(parseRemoteAccessArguments([]), { help: true });
  assert.deepEqual(parseRemoteAccessArguments(["plan", "--protected-root", "/protected"]), { command: "plan", protectedRoot: "/protected" });
  for (const args of [["run", "--protected-root", "/p"], ["plan", "--protected-root", "relative"], ["plan", "--protected-root", "/p/../q"],
    ["write-cloudflared", "--protected-root", "/p", "--tunnel-id", "not-a-uuid", "--credentials-file", "/p/c.json"],
    ["write-cloudflared", "--protected-root", "/p", "--tunnel-id", tunnelId],
    ["plan", "--protected-root", "/p", "--tunnel-id", tunnelId], ["plan", "--protected-root", "/p", "--protected-root", "/q"]])
    assert.throws(() => parseRemoteAccessArguments(args), /remote_access_arguments_invalid/, args.join(" "));
});

test("plan prints only safe commands and never Funnel as an instruction", async t => {
  const root = await protectedRoot(both); t.after(() => rm(root, { recursive: true, force: true }));
  const configuration = await loadMacLocalProtectedConfigurationFromRootV1(root);
  const plan = remoteAccessPlan(configuration, root).join("\n");
  assert.match(plan, /tailscale serve --bg --https=443 http:\/\/127\.0\.0\.1:3210/);
  assert.match(plan, /Never run `tailscale funnel`/);
  assert.doesNotMatch(plan, /^\s*\d\. tailscale funnel/mu);
  assert.match(plan, /cloudflared tunnel route dns control-room private-app\.example\.invalid/);
  const off = await protectedRoot(); t.after(() => rm(off, { recursive: true, force: true }));
  assert.match(remoteAccessPlan(await loadMacLocalProtectedConfigurationFromRootV1(off), off).join("\n"), /Remote access is off/);
});

test("cloudflared config is outbound-only, one hostname, loopback service, Access-checked, 404 otherwise", async t => {
  const root = await protectedRoot(both); t.after(() => rm(root, { recursive: true, force: true }));
  const configuration = await loadMacLocalProtectedConfigurationFromRootV1(root);
  const credentials = join(root, "config", `${tunnelId}.json`);
  const text = renderCloudflaredConfig(configuration, tunnelId, credentials);
  assert.equal(text, [
    "# Written by `pnpm mac:remote-access write-cloudflared`. Private: keep this file out of any repository.",
    "# cloudflared only dials out to Cloudflare. Nothing on this Mac listens on a public address.",
    `tunnel: ${tunnelId}`, `credentials-file: ${JSON.stringify(credentials)}`, "no-autoupdate: true", "ingress:",
    "  - hostname: private-app.example.invalid", "    service: http://127.0.0.1:3210", "    originRequest:",
    "      httpHostHeader: private-app.example.invalid", "      access:", "        required: true",
    "        teamName: example-team", "        audTag:", `          - ${audience}`, "  - service: http_status:404", ""].join("\n"));
  assert.doesNotMatch(text, /noTLSVerify|warp-routing|0\.0\.0\.0|funnel/u);
});

test("check passes a correct setup and fails edits, loose modes and leaked private names", async t => {
  const root = await protectedRoot(both); t.after(() => rm(root, { recursive: true, force: true }));
  const configuration = await loadMacLocalProtectedConfigurationFromRootV1(root);
  const credentials = join(root, "config", `${tunnelId}.json`);
  await writeFile(credentials, "{}", { mode: 0o600 });
  const missing = await checkRemoteAccess(configuration, root, undefined);
  assert.equal(missing.ok, false); assert.match(missing.lines.join("\n"), /cloudflared\.yml is missing/);
  const path = await writeCloudflaredConfig(configuration, root, tunnelId, credentials);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const good = await checkRemoteAccess(configuration, root, undefined);
  assert.equal(good.ok, true, good.lines.join("\n"));

  await writeFile(path, (await readFile(path, "utf8")).replace("http_status:404", "http://127.0.0.1:22"));
  assert.equal((await checkRemoteAccess(configuration, root, undefined)).ok, false, "an extra route is refused");
  await writeCloudflaredConfig(configuration, root, tunnelId, credentials).catch(() => {});
  await rm(path); await writeCloudflaredConfig(configuration, root, tunnelId, credentials);
  await chmod(path, 0o644);
  assert.match((await checkRemoteAccess(configuration, root, undefined)).lines.join("\n"), /must be a private file/);
  await chmod(path, 0o600); await chmod(credentials, 0o644);
  assert.match((await checkRemoteAccess(configuration, root, undefined)).lines.join("\n"), /FAIL  the tunnel credentials file/);
  await chmod(credentials, 0o600);

  const repository = await mkdtemp(join(tmpdir(), "control-room-remote-access-repo-"));
  t.after(() => rm(repository, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q", repository]);
  await writeFile(join(repository, "index.html"), "<a href=\"https://agentcontrolroom.xyz\">Public site</a>");
  execFileSync("git", ["-C", repository, "add", "index.html"]);
  assert.equal((await checkRemoteAccess(configuration, root, repository)).ok, true);
  await writeFile(join(repository, "leak.md"), "Open https://private-app.example.invalid to use the app");
  execFileSync("git", ["-C", repository, "add", "leak.md"]);
  const leaked = await checkRemoteAccess(configuration, root, repository);
  assert.equal(leaked.ok, false); assert.match(leaked.lines.join("\n"), /leak\.md/);
});

test("check never reports a non-tailnet Tailscale origin as a tailnet address", async t => {
  const root = await protectedRoot({ schema: MAC_LOCAL_REMOTE_ACCESS_V1, tailscale: { origin: tailnetOrigin } });
  t.after(() => rm(root, { recursive: true, force: true }));
  const configuration = await loadMacLocalProtectedConfigurationFromRootV1(root);
  const tailnet = await checkRemoteAccess(configuration, root, undefined);
  assert.equal(tailnet.ok, true); assert.match(tailnet.lines.join("\n"), /PASS {2}Tailscale origin .* is a tailnet \(\.ts\.net\) address/u);
  // The loader already refuses such a configuration; the check computes the fact itself anyway.
  const publicProxy = await checkRemoteAccess({ ...configuration,
    remoteAccess: { tailscale: { origin: "https://public-proxy.example.invalid" } } }, root, undefined);
  assert.equal(publicProxy.ok, false);
  assert.doesNotMatch(publicProxy.lines.join("\n"), /PASS {2}Tailscale origin/u);
  assert.match(publicProxy.lines.join("\n"), /FAIL {2}Tailscale origin https:\/\/public-proxy\.example\.invalid is not a tailnet/u);
});

test("a legacy trustedOrigin that is not a tailnet address stops loading, so check cannot pass it", async t => {
  const root = await protectedRoot();
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "config", "mac-local.json");
  const value = JSON.parse(await readFile(file, "utf8"));
  value.localOwnerSession.trustedOrigin = "https://public-proxy.example.invalid";
  await writeFile(file, JSON.stringify(value), { mode: 0o600 });
  // The loader reports every configuration refusal with one code.
  await assert.rejects(loadMacLocalProtectedConfigurationFromRootV1(root), /mac_local_protected_configuration_root_invalid/u);
  value.localOwnerSession.trustedOrigin = tailnetOrigin;
  await writeFile(file, JSON.stringify(value), { mode: 0o600 });
  const legacy = await loadMacLocalProtectedConfigurationFromRootV1(root);
  assert.deepEqual(legacy.remoteAccess, { tailscale: { origin: tailnetOrigin } });
});
