import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  NodeFilesystemInspector,
  TargetGuardError,
  authorizeExistingFilesystemTarget,
  authorizeNewFileTarget,
  authorizeRedirectHop,
  canonicalNetworkDestinationSchema,
  classifyIpAddress,
  preparePinnedHttpsConnection,
  revalidateAuthorizedFilesystemPlan,
  verifyPinnedTlsPeer,
  type FilesystemInspectorV1,
  type FilesystemObjectEvidenceV1,
  type NetworkResolverV1,
} from "../src/node-policy/v1/index.ts";

class FakeFilesystemInspector implements FilesystemInspectorV1 {
  readonly dialect;
  private readonly objects: Map<string, FilesystemObjectEvidenceV1>;

  constructor(dialect: "posix" | "windows", objects: Record<string, FilesystemObjectEvidenceV1>) {
    this.dialect = dialect;
    this.objects = new Map(Object.entries(objects));
  }

  async inspectExisting(path: string): Promise<FilesystemObjectEvidenceV1> {
    const value = this.objects.get(path);
    if (!value) throw new TargetGuardError("target_unavailable");
    return { ...value };
  }

  async exists(path: string): Promise<boolean> {
    return this.objects.has(path);
  }

  set(path: string, value: FilesystemObjectEvidenceV1): void {
    this.objects.set(path, value);
  }
}

const directory = (realPath: string, volumeId = "volume:1", objectId = `directory:${realPath}`): FilesystemObjectEvidenceV1 => ({
  realPath, volumeId, objectId, objectType: "directory",
});
const file = (realPath: string, volumeId = "volume:1", objectId = `file:${realPath}`): FilesystemObjectEvidenceV1 => ({
  realPath, volumeId, objectId, objectType: "file",
});

function guardedCode(code: string) {
  return (error: unknown) => error instanceof TargetGuardError && error.code === code;
}

test("filesystem guard authorizes real containment and returns pinned object evidence", async () => {
  const inspector = new FakeFilesystemInspector("posix", {
    "/allowed": directory("/real/allowed"),
    "/allowed/existing.txt": file("/real/allowed/existing.txt"),
    "/allowed/new": directory("/real/allowed/new"),
  });
  const existing = await authorizeExistingFilesystemTarget({ canonicalPath: "/allowed/existing.txt", allowedRoots: ["/allowed"], inspector });
  assert.deepEqual(existing, {
    kind: "existing", requestedPath: "/allowed/existing.txt", realPath: "/real/allowed/existing.txt",
    allowedRootPath: "/allowed",
    allowedRootRealPath: "/real/allowed", volumeId: "volume:1", rootObjectId: "directory:/real/allowed",
    targetObjectId: "file:/real/allowed/existing.txt",
  });
  const created = await authorizeNewFileTarget({ canonicalPath: "/allowed/new/output.txt", allowedRoots: ["/allowed"], inspector });
  assert.equal(created.kind, "new_file");
  assert.equal(created.kind === "new_file" ? created.candidateRealPath : "", "/real/allowed/new/output.txt");
  assert.equal(created.kind === "new_file" ? created.parentObjectId : "", "directory:/real/allowed/new");
  await revalidateAuthorizedFilesystemPlan(existing, inspector);
  await revalidateAuthorizedFilesystemPlan(created, inspector);
  inspector.set("/allowed/existing.txt", file("/outside/replaced.txt", "volume:2"));
  await assert.rejects(revalidateAuthorizedFilesystemPlan(existing, inspector), guardedCode("identity_mismatch"));
  inspector.set("/allowed/new/output.txt", file("/real/allowed/new/output.txt"));
  await assert.rejects(revalidateAuthorizedFilesystemPlan(created, inspector), guardedCode("identity_mismatch"));
});

test("filesystem guard denies traversal equivalents, symlink/junction escape, prefix tricks, and mount changes", async () => {
  const inspector = new FakeFilesystemInspector("posix", {
    "/allowed": directory("/real/allowed"),
    "/allowed/link/file.txt": file("/outside/file.txt"),
    "/allowed-other/file.txt": file("/real/allowed-other/file.txt"),
    "/allowed/mount/file.txt": file("/real/allowed/mount/file.txt", "volume:2"),
    "/allowed/link": directory("/outside"),
    "/allowed/file-parent": file("/real/allowed/file-parent"),
  });
  await assert.rejects(authorizeExistingFilesystemTarget({ canonicalPath: "/allowed/link/file.txt", allowedRoots: ["/allowed"], inspector }), guardedCode("target_not_allowed"));
  await assert.rejects(authorizeExistingFilesystemTarget({ canonicalPath: "/allowed-other/file.txt", allowedRoots: ["/allowed"], inspector }), guardedCode("target_not_allowed"));
  await assert.rejects(authorizeExistingFilesystemTarget({ canonicalPath: "/allowed/mount/file.txt", allowedRoots: ["/allowed"], inspector }), guardedCode("target_not_allowed"));
  await assert.rejects(authorizeNewFileTarget({ canonicalPath: "/allowed/link/new.txt", allowedRoots: ["/allowed"], inspector }), guardedCode("target_not_allowed"));
  await assert.rejects(authorizeNewFileTarget({ canonicalPath: "/allowed/file-parent/new.txt", allowedRoots: ["/allowed"], inspector }), guardedCode("target_not_allowed"));
  await assert.rejects(authorizeExistingFilesystemTarget({ canonicalPath: "/allowed/../outside", allowedRoots: ["/allowed"], inspector }), guardedCode("invalid_target"));
  await assert.rejects(authorizeExistingFilesystemTarget({ canonicalPath: "/allowed/link/file.txt", allowedRoots: ["/z", "/allowed"], inspector }), guardedCode("target_not_allowed"));
});

test("filesystem containment is dialect-aware and new-file mode never authorizes overwrite", async () => {
  const inspector = new FakeFilesystemInspector("windows", {
    "C:\\Root": directory("C:\\Real\\Root"),
    "C:\\Root\\Folder": directory("C:\\Real\\Root\\Folder"),
    "C:\\Root\\Folder\\existing.txt": file("C:\\Real\\Root\\Folder\\existing.txt"),
    "C:\\Root2\\file.txt": file("C:\\Real\\Root2\\file.txt"),
  });
  const plan = await authorizeExistingFilesystemTarget({ canonicalPath: "C:\\Root\\Folder\\existing.txt", allowedRoots: ["C:\\Root"], inspector });
  assert.equal(plan.kind === "existing" ? plan.realPath : "", "C:\\Real\\Root\\Folder\\existing.txt");
  await assert.rejects(authorizeExistingFilesystemTarget({ canonicalPath: "C:\\Root2\\file.txt", allowedRoots: ["C:\\Root"], inspector }), guardedCode("target_not_allowed"));
  await assert.rejects(authorizeNewFileTarget({ canonicalPath: "C:\\Root\\Folder\\existing.txt", allowedRoots: ["C:\\Root"], inspector }), guardedCode("target_not_allowed"));
  await assert.rejects(authorizeNewFileTarget({ canonicalPath: "C:\\Root\\Folder\\file.txt:secret", allowedRoots: ["C:\\Root"], inspector }), guardedCode("invalid_target"));
  await assert.rejects(authorizeNewFileTarget({ canonicalPath: "C:\\Root\\Folder\\CON.txt", allowedRoots: ["C:\\Root"], inspector }), guardedCode("invalid_target"));
});

test("node filesystem inspector proves controlled existing and new targets without writing them", async () => {
  const root = await mkdtemp(join(tmpdir(), "control-room-target-"));
  const existing = join(root, "existing.txt");
  const candidate = join(root, "new.txt");
  try {
    await writeFile(existing, "fixture", "utf8");
    const inspector = new NodeFilesystemInspector();
    const existingPlan = await authorizeExistingFilesystemTarget({ canonicalPath: existing, allowedRoots: [root], inspector });
    assert.equal(existingPlan.kind, "existing");
    const newPlan = await authorizeNewFileTarget({ canonicalPath: candidate, allowedRoots: [root], inspector });
    assert.equal(newPlan.kind, "new_file");
    assert.equal(await inspector.exists(candidate), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class FakeResolver implements NetworkResolverV1 {
  calls: string[] = [];
  constructor(private readonly answers: Record<string, string[] | Error>) {}
  async resolve(host: string): Promise<string[]> {
    this.calls.push(host);
    const answer = this.answers[host];
    if (answer instanceof Error) throw answer;
    return [...(answer ?? [])];
  }
}

const executor = { exposesFinalDestination: true, supportsPinnedTlsConnection: true };
const resolvedAt = "2026-08-23T12:00:00.000Z";

test("canonical HTTPS grammar rejects alternate spellings rather than silently normalizing", () => {
  for (const allowed of ["https://api.example.test:443", "https://xn--bcher-kva.example:8443", "https://127.0.0.1:443"]) {
    assert.equal(canonicalNetworkDestinationSchema.safeParse(allowed).success, true, allowed);
  }
  for (const denied of [
    "https://API.example.test:443", "https://api.example.test", "https://api.example.test:443/path",
    "https://127.0.0.01:443", "https://2130706433:443", "https://bücher.example:443", "http://api.example.test:80",
    "https://user@api.example.test:443", "https://api.example.test:443?query=1", "https://api.example.test:443#fragment",
  ]) assert.equal(canonicalNetworkDestinationSchema.safeParse(denied).success, false, denied);
});

test("network guard resolves once, pins public addresses, and requires TLS hostname evidence", async () => {
  const resolver = new FakeResolver({ "api.example.test": ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946", "93.184.216.34"] });
  const plan = await preparePinnedHttpsConnection({
    canonicalDestination: "https://api.example.test:443", allowedDestinations: ["https://api.example.test:443"],
    resolver, executor, resolvedAt,
  });
  assert.deepEqual(resolver.calls, ["api.example.test"]);
  assert.deepEqual(plan.pinnedAddresses, ["2606:2800:220:1:248:1893:25c8:1946", "93.184.216.34"]);
  verifyPinnedTlsPeer(plan, { connectedAddress: "93.184.216.34", connectedPort: 443, serverName: "api.example.test", certificateHostnameVerified: true });
  assert.throws(() => verifyPinnedTlsPeer(plan, { connectedAddress: "93.184.216.35", connectedPort: 443, serverName: "api.example.test", certificateHostnameVerified: true }), guardedCode("identity_mismatch"));
  assert.throws(() => verifyPinnedTlsPeer(plan, { connectedAddress: "93.184.216.34", connectedPort: 80, serverName: "api.example.test", certificateHostnameVerified: true }), guardedCode("identity_mismatch"));
  assert.throws(() => verifyPinnedTlsPeer(plan, { connectedAddress: "93.184.216.34", connectedPort: 443, serverName: "api.example.test", certificateHostnameVerified: false }), guardedCode("identity_mismatch"));
});

test("DNS answers containing private, loopback, documentation, or mixed addresses fail closed", async () => {
  for (const answer of [["10.0.0.1"], ["127.0.0.1"], ["192.0.2.1"], ["93.184.216.34", "169.254.169.254"], ["fc00::1"]]) {
    const resolver = new FakeResolver({ "api.example.test": answer });
    await assert.rejects(preparePinnedHttpsConnection({
      canonicalDestination: "https://api.example.test:443", allowedDestinations: ["https://api.example.test:443"],
      resolver, executor, resolvedAt,
    }), guardedCode("prohibited_address"));
  }
});

test("an exact canonical IP-literal ceiling entry is the only special-address exception", async () => {
  const resolver = new FakeResolver({});
  const plan = await preparePinnedHttpsConnection({
    canonicalDestination: "https://127.0.0.1:443", allowedDestinations: ["https://127.0.0.1:443"], resolver, executor, resolvedAt,
  });
  assert.equal(plan.literalAddressException, true);
  assert.deepEqual(plan.pinnedAddresses, ["127.0.0.1"]);
  assert.deepEqual(resolver.calls, []);
  await assert.rejects(preparePinnedHttpsConnection({
    canonicalDestination: "https://127.0.0.1:443", allowedDestinations: ["https://127.0.0.2:443"], resolver, executor, resolvedAt,
  }), guardedCode("target_not_allowed"));
});

test("redirect hops receive a new authorization and pin plan and opaque executors are excluded", async () => {
  const resolver = new FakeResolver({
    "one.example.test": ["93.184.216.34"], "two.example.test": ["93.184.216.35"], "three.example.test": ["93.184.216.36"],
  });
  const allowed = ["https://one.example.test:443", "https://two.example.test:443"];
  const first = await preparePinnedHttpsConnection({ canonicalDestination: allowed[0], allowedDestinations: allowed, resolver, executor, resolvedAt });
  const second = await authorizeRedirectHop({
    previousPlan: first, nextCanonicalDestination: allowed[1], allowedDestinations: allowed, resolver, executor,
    resolvedAt: "2026-08-23T12:00:01.000Z",
  });
  assert.equal(second.host, "two.example.test");
  assert.deepEqual(resolver.calls, ["one.example.test", "two.example.test"]);
  await assert.rejects(authorizeRedirectHop({
    previousPlan: second, nextCanonicalDestination: "https://three.example.test:443", allowedDestinations: allowed,
    resolver, executor, resolvedAt: "2026-08-23T12:00:02.000Z",
  }), guardedCode("target_not_allowed"));
  await assert.rejects(preparePinnedHttpsConnection({
    canonicalDestination: allowed[0], allowedDestinations: allowed, resolver,
    executor: { exposesFinalDestination: false, supportsPinnedTlsConnection: false }, resolvedAt,
  }), guardedCode("unsupported_executor"));
});

test("IP classification is deterministic for the v1 global and prohibited sets", () => {
  assert.equal(classifyIpAddress("93.184.216.34").scope, "global");
  assert.equal(classifyIpAddress("10.0.0.1").scope, "private");
  assert.equal(classifyIpAddress("127.0.0.1").scope, "loopback");
  assert.equal(classifyIpAddress("169.254.1.1").scope, "link_local");
  assert.equal(classifyIpAddress("224.0.0.1").scope, "multicast");
  assert.equal(classifyIpAddress("2001:db8::1").scope, "documentation");
  assert.equal(classifyIpAddress("3fff::1").scope, "documentation");
  assert.equal(classifyIpAddress("2001::1").scope, "reserved");
  assert.equal(classifyIpAddress("2606:2800:220:1:248:1893:25c8:1946").scope, "global");
  assert.equal(classifyIpAddress("::1").scope, "loopback");
});
