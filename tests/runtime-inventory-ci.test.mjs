import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyRuntimeInventoryV1 } from "../scripts/ci/verify-runtime-inventory.mjs";

const sha256 = body => createHash("sha256").update(body).digest("hex");
const cleanup = root => rm(root, { recursive: true, force: true });
function verifierInventory(bodies, nodeProof = { kind: "none" }) {
  const names = ["node", "pnpm", "esbuild", "postgresql"], links = ["node", "pnpm", "esbuild", "pg"],
    extractions = ["tar-gz-strip-1", "tar-gz", "npm-tgz-bin-esbuild", "edb-zip-allowlist-v1"];
  return { schema: "control-room.runtime-inventory/v1", platform: "darwin", architecture: "arm64", artifacts: names.map((tool, index) => ({
    tool, version: tool === "postgresql" ? "17.11" : "1.2.3", linkBase: links[index],
    archiveName: tool === "postgresql" ? "postgresql-17.11-4-osx-binaries.zip" : `${tool}.tgz`, url: `https://fixture.invalid/${tool}`,
    archiveSha256: sha256(bodies[tool]), archiveBytes: bodies[tool].length, extraction: extractions[index],
    executableRelativePath: tool === "node" ? "bin/node" : tool === "postgresql" ? "bin/postgres" : tool,
    executableSha256: String(index + 1).repeat(64), publisherProof: tool === "node" ? nodeProof : { kind: "none" },
    // PostgreSQL policy requires a Developer ID for synthetic fixtures too.
    ...(tool === "postgresql"
      ? { provenance: { etag: null, lastModified: null }, teamIdentifier: "26QKX55P9K",
        publisherProof: { kind: "developer-id", teamIdentifier: "26QKX55P9K",
          identifier: "com.edb.postgresql", measured: "fixture" } }
      : {}),
  })) };
}

test("CI verifier reports artifact and proof step without exposing subprocess or transport errors", async t => {
  const bodies = { node: Buffer.from("node"), pnpm: Buffer.from("pnpm"), esbuild: Buffer.from("esbuild"), postgresql: Buffer.from("pg") };
  const proof = { kind: "nodejs-shasums-gpg", shasumsUrl: "https://fixture.invalid/sums",
    signatureUrl: "https://fixture.invalid/signature", keyringUrl: "https://fixture.invalid/keyring",
    signerFingerprints: ["A".repeat(40)] };
  const inventory = verifierInventory(bodies, proof);
  const sums = `${sha256(bodies.node)}  node.tgz\n`;
  const run = async (change = {}) => {
    const root = await mkdtemp(join(tmpdir(), "acr-ci-diagnostic-")); t.after(() => cleanup(root));
    return verifyRuntimeInventoryV1({ inventory: change.inventory ?? inventory, workDirectory: root }, {
      async downloadToFile(url, destination) {
        const name = url.split("/").at(-1);
        if (change.drop === name) throw new Error("private transport diagnostic");
        const body = bodies[name] ?? Buffer.from(name === "sums" ? sums : "fixture proof");
        if (!change.missingArchive) await writeFile(destination, body);
        return body.length;
      },
      async run(file, args) {
        assert.equal(file, "/usr/bin/gpgv");
        assert.equal(args[0], "--homedir");
        assert.equal(args[1], join(root, "node"));
        if (change.toolError) throw Object.assign(new Error("private subprocess diagnostic"), { code: change.toolError });
        if (!change.noVerified) await writeFile(args[args.indexOf("--output") + 1], change.content ?? sums);
        return { stdout: change.status ?? `[GNUPG:] VALIDSIG ${"A".repeat(40)} 2026-01-01 0 0 4 0 22 8 01 ${"A".repeat(40)}\n` };
      },
    });
  };
  assert.equal((await run()).verified.length, 4);
  for (const [change, step] of [
    [{ inventory: {} }, "inventory:validate"],
    [{ drop: "node" }, "node:archive_download"],
    [{ missingArchive: true }, "node:archive_read_missing"],
    [{ drop: "sums" }, "node:node_shasums_download"],
    [{ drop: "signature" }, "node:node_signature_download"],
    [{ drop: "keyring" }, "node:node_keyring_download"],
    [{ toolError: "ENOENT" }, "node:node_gpg_verify_missing"],
    [{ toolError: "EIO" }, "node:node_gpg_verify"],
    [{ noVerified: true }, "node:node_gpg_authenticated_read_missing"],
    [{ status: "no valid signature" }, "node:node_gpg_validsig_missing"],
    [{ status: `[GNUPG:] VALIDSIG ${"B".repeat(40)} 0\n` }, "node:node_gpg_signer_mismatch"],
    [{ content: "tampered" }, "node:node_shasums_content_mismatch"],
  ]) {
    await assert.rejects(run(change), error => error.message === `runtime_inventory_verification_failed:${step}`);
  }
  const wrong = structuredClone(inventory); wrong.artifacts[0].archiveSha256 = "0".repeat(64);
  await assert.rejects(run({ inventory: wrong }), /node:archive_digest_or_size_mismatch/u);
  // Bind the signed checksum row independently of the downloaded archive hash.
  const wrongName = structuredClone(inventory); wrongName.artifacts[0].archiveName = "other.tgz";
  await assert.rejects(run({ inventory: wrongName }), /node:node_shasums_archive_mismatch/u);
  const burst = await Promise.all(Array.from({ length: 20 }, () => run()));
  assert.ok(burst.every(result => result.verified.length === 4));
  assert.equal((await run()).verified.length, 4, "retry after failed proof verification succeeds");
});

test("CI verifier CLI prints only the artifact refusal when transport fails", async t => {
  const root = await mkdtemp(join(tmpdir(), "acr-ci-cli-")); t.after(() => cleanup(root));
  const preload = join(root, "offline.mjs");
  await writeFile(preload, 'globalThis.fetch = async () => { throw new Error("private transport diagnostic"); };\n');
  const result = spawnSync(process.execPath, ["--import", preload, "scripts/ci/verify-runtime-inventory.mjs"],
    { encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "runtime_inventory_verification_failed:node:archive_download\n");
});

test("CI verifier diagnoses HTTP, size and stream failures with synthetic responses", async t => {
  const bodies = { node: Buffer.from("node"), pnpm: Buffer.from("pnpm"), esbuild: Buffer.from("esbuild"), postgresql: Buffer.from("pg") };
  const inventory = verifierInventory(bodies);
  let responseChange = {};
  t.mock.method(globalThis, "fetch", async url => {
    const body = bodies[url.split("/").at(-1)];
    const response = new Response(responseChange.status === 204 ? null : responseChange.body ?? body, {
      status: responseChange.status ?? 200, headers: responseChange.headers,
    });
    Object.defineProperty(response, "url", { value: responseChange.url ?? url });
    return response;
  });
  const run = async change => {
    responseChange = change;
    const workDirectory = await mkdtemp(join(tmpdir(), "acr-ci-http-")); t.after(() => cleanup(workDirectory));
    return verifyRuntimeInventoryV1({ inventory, workDirectory });
  };
  assert.equal((await run({})).verified.length, 4);
  for (const [change, step] of [
    [{ status: 404 }, "archive_download_http_404"],
    [{ status: 204 }, "archive_download_response_invalid"],
    [{ url: "http://fixture.invalid/node" }, "archive_download_response_invalid"],
    [{ headers: { "content-length": "invalid" } }, "archive_download_size_limit"],
    [{ headers: { "content-length": "1000" } }, "archive_download_size_limit"],
    [{ body: Buffer.from("too many bytes") }, "archive_download_size_limit"],
    [{ body: new ReadableStream({ start(controller) { controller.error(new Error("private stream failure")); } }) }, "archive_download"],
  ]) {
    await assert.rejects(run(change), error => error.message === `runtime_inventory_verification_failed:node:${step}`);
  }
  assert.equal((await run({})).verified.length, 4);
});

test("CI verifier diagnoses malformed npm proofs, archive integrity and concurrent destinations", async t => {
  const bodies = { node: Buffer.from("node"), pnpm: Buffer.from("pnpm"), esbuild: Buffer.from("esbuild"), postgresql: Buffer.from("pg") };
  const inventory = verifierInventory(bodies);
  const esbuild = inventory.artifacts[2];
  const integrity = createHash("sha512").update(bodies.esbuild).digest("base64");
  esbuild.publisherProof = { kind: "npm-integrity", metadataUrl: "https://fixture.invalid/metadata", sha512: integrity };
  const run = async (change = {}, root) => {
    const workDirectory = root ?? await mkdtemp(join(tmpdir(), "acr-ci-npm-")); t.after(() => cleanup(workDirectory));
    const selected = structuredClone(inventory);
    if (change.archiveProof) selected.artifacts[2].publisherProof.sha512 = "A".repeat(86) + "==";
    return verifyRuntimeInventoryV1({ inventory: selected, workDirectory }, { async downloadToFile(url, path) {
      const name = url.split("/").at(-1);
      const body = name === "metadata" ? Buffer.from(change.metadata ?? JSON.stringify({ dist: {
        integrity: `sha512-${change.archiveProof ? selected.artifacts[2].publisherProof.sha512 : integrity}`,
        tarball: change.tarball ?? esbuild.url,
      } })) : bodies[name];
      await writeFile(path, body); return body.length;
    } });
  };
  assert.equal((await run()).verified.length, 4);
  await assert.rejects(run({ metadata: "{" }), /esbuild:npm_metadata_invalid/u);
  await assert.rejects(run({ metadata: "{}" }), /esbuild:npm_integrity_mismatch/u);
  await assert.rejects(run({ archiveProof: true }), /esbuild:npm_integrity_mismatch/u);
  await assert.rejects(run({ tarball: "https://fixture.invalid/other" }), /esbuild:npm_tarball_mismatch/u);
  const root = await mkdtemp(join(tmpdir(), "acr-ci-concurrent-"));
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => run({}, root)));
  assert.equal(results.filter(row => row.status === "fulfilled").length, 1);
  for (const row of results.filter(row => row.status === "rejected")) {
    assert.equal(row.reason.message, "runtime_inventory_verification_failed:node:work_directory");
  }
});
