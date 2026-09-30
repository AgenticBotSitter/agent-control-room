import assert from "node:assert/strict";
import { spawn, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import test from "node:test";
import {
  SandboxedTextCopyService,
  TEXT_COPY_LIMITS,
} from "../src/converter/v1/text-copy-service.ts";

const root = process.cwd();
const fakePdf = join(root, "tests", "fixtures", "fake-pdftotext.mjs");
const sandboxExecutable = "/usr/bin/true";

function directSpawn(capture?: (file: string, args: readonly string[], options: SpawnOptions) => void): typeof spawn {
  return ((file: string, args: readonly string[], options: SpawnOptions) => {
    capture?.(file, args, options);
    if (file === sandboxExecutable && args[0] === "-p") {
      return spawn(args[2], args.slice(3), options);
    }
    return spawn(file, args, options);
  }) as typeof spawn;
}

function service(overrides: ConstructorParameters<typeof SandboxedTextCopyService>[0] = {}, capture?: Parameters<typeof directSpawn>[0]) {
  return new SandboxedTextCopyService({
    repositoryRoot: root,
    sandboxExecutable,
    nodeExecutable: process.execPath,
    pdfExecutable: process.execPath,
    pdfPrefixArguments: [fakePdf],
    ...overrides,
  }, { spawnProcess: directSpawn(capture), skipNetworkDenialProbe: true, skipMemoryLimitProbe: true });
}

function bytes(value: string): Uint8Array { return Buffer.from(value); }
function text(value: Uint8Array): string { return Buffer.from(value).toString("utf8"); }
async function missing(path: string): Promise<boolean> {
  try { await access(path); return false; } catch { return true; }
}

test("HTML to Markdown returns a digest, fixed converter identity, and safe readable text", async () => {
  const converter = service();
  const converted = await converter.convert({ format: "html", sourceBytes: bytes(`<!doctype html>
    <html><head><title>Quarterly *review*</title></head><body><main><h1>Result</h1>
    <p>Owner-ready text with [literal] punctuation.</p></main></body></html>`) });
  assert.equal(converted.status, "succeeded");
  assert.equal(converted.diagnosticCategory, "none");
  assert.deepEqual(converted.converter, { id: "control-room.html-readability-markdown", version: "1.0.0" });
  assert.match(converted.sourceDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.ok(text(converted.markdownBytes).startsWith("# Quarterly \\*review\\*"));
  assert.ok(text(converted.markdownBytes).includes("Owner\\-ready text with \\[literal\\] punctuation\\."));
});

test("malicious scripts and deep HTML nesting produce safe text without a network request", async t => {
  let requests = 0;
  const server = await new Promise<Server>(resolveServer => {
    const value = createServer((_request, response) => {
      requests += 1;
      response.end("NETWORK SECRET");
    });
    value.listen(0, "127.0.0.1", () => resolveServer(value));
  });
  t.after(() => new Promise<void>(resolveClose => server.close(() => resolveClose())));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const nesting = "<div>".repeat(100);
  const closing = "</div>".repeat(100);
  const html = `<html><head><title>Safe result</title><link rel="stylesheet" href="http://127.0.0.1:${address.port}/style"></head>
    <body>${nesting}<article><p>Retained body text.</p><img src="http://127.0.0.1:${address.port}/pixel">
    <script>fetch("http://127.0.0.1:${address.port}/steal").then(r=>r.text()).then(t=>document.body.append(t))</script>
    </article>${closing}</body></html>`;
  const converted = await service().convert({ format: "html", sourceBytes: bytes(html) });
  assert.equal(converted.status, "succeeded");
  assert.match(text(converted.markdownBytes), /Retained body text/u);
  assert.doesNotMatch(text(converted.markdownBytes), /fetch|NETWORK SECRET|<script|127\.0\.0\.1/iu);
  await new Promise(resolveWait => setTimeout(resolveWait, 100));
  assert.equal(requests, 0);
});

test("PDF to text uses one fixed no-shell argv template", async () => {
  const calls: Array<{ file: string; args: readonly string[]; shell: unknown }> = [];
  const converter = service({}, (file, args, options) => {
    if (file !== "/bin/ps") calls.push({ file, args, shell: options.shell });
  });
  const converted = await converter.convert({ format: "pdf", sourceBytes: bytes("%PDF-fixture report") });
  assert.equal(converted.status, "succeeded");
  assert.equal(text(converted.markdownBytes), "Extracted PDF text: fixture report\n");
  assert.deepEqual(converted.converter, { id: "control-room.pdftotext", version: "1.0.0" });
  assert.equal(calls[0].file, sandboxExecutable);
  assert.equal(calls[0].args[0], "-p");
  assert.equal(calls[0].args[2], process.execPath);
  assert.deepEqual(calls[0].args.slice(3, 7), [fakePdf, "-enc", "UTF-8", "-nopgbrk"]);
  assert.equal(calls[0].shell, false);
});

test("the generated sandbox is deny-by-default and admits no network operation", async () => {
  let profile = "";
  const converter = service({}, (file, args) => {
    if (file === sandboxExecutable) profile = args[1];
  });
  assert.equal((await converter.convert({ format: "html", sourceBytes: bytes("<article>Policy test body text.</article>") })).status, "succeeded");
  assert.match(profile, /\(deny default\)/u);
  assert.match(profile, /\(deny network\*\)/u);
  assert.doesNotMatch(profile, /\(allow network/u);
  assert.match(profile, /\(allow signal \(target same-sandbox\)\)/u);
});

test("production commands require the worker's denied-network proof", async () => {
  let observedProbe: string | undefined;
  const spawnProcess = ((file: string, args: readonly string[], options: SpawnOptions) => {
    if (file === sandboxExecutable && args[0] === "-p") {
      observedProbe = options.env?.CONTROL_ROOM_NETWORK_DENIAL_PROBE;
      return spawn(args[2], args.slice(3), {
        ...options,
        env: {
          ...options.env,
          NODE_ENV: options.env?.NODE_ENV ?? "test",
          CONTROL_ROOM_NETWORK_DENIAL_PROBE: "test-bypass",
        },
      });
    }
    return spawn(file, args, options);
  }) as typeof spawn;
  const converter = new SandboxedTextCopyService({ repositoryRoot: root, sandboxExecutable }, {
    spawnProcess,
    skipMemoryLimitProbe: true,
  });
  const converted = await converter.convert({ format: "html", sourceBytes: bytes("<article>Probe body text.</article>") });
  assert.equal(converted.status, "succeeded");
  assert.equal(observedProbe, "required");
});

test("the fixed child environment does not inherit service secrets", async t => {
  const previous = process.env.CONVERTER_FORBIDDEN_SECRET;
  process.env.CONVERTER_FORBIDDEN_SECRET = "must-not-cross";
  t.after(() => {
    if (previous === undefined) delete process.env.CONVERTER_FORBIDDEN_SECRET;
    else process.env.CONVERTER_FORBIDDEN_SECRET = previous;
  });
  let childEnvironment: NodeJS.ProcessEnv | undefined;
  const converter = service({}, (file, _args, options) => {
    if (file === sandboxExecutable) childEnvironment = options.env;
  });
  assert.equal((await converter.convert({ format: "html", sourceBytes: bytes("<article>Environment body.</article>") })).status, "succeeded");
  assert.equal(childEnvironment?.CONVERTER_FORBIDDEN_SECRET, undefined);
  assert.match(childEnvironment?.HOME ?? "", /^\/tmp\/acr-convert-/u);
  assert.equal(childEnvironment?.HOME, childEnvironment?.TMPDIR);
});

test("oversize and missing inputs are refused before a process starts", async () => {
  let starts = 0;
  const converter = service({ limits: { htmlInputBytes: 32 } }, () => { starts += 1; });
  const oversize = await converter.convert({ format: "html", sourceBytes: bytes("x".repeat(33)) });
  const missingInput = await converter.convert({ format: "pdf", sourceBytes: new Uint8Array() });
  assert.equal(oversize.diagnosticCategory, "input_too_large");
  assert.equal(missingInput.diagnosticCategory, "invalid_input");
  assert.equal(starts, 0);
  assert.equal(oversize.markdownBytes.length, 0);
});

test("invalid runtime formats and unsafe configuration are refused", async () => {
  const invalidFormat = await service().convert({
    format: "rtf" as never,
    sourceBytes: bytes("opaque"),
  });
  assert.equal(invalidFormat.diagnosticCategory, "invalid_input");
  assert.throws(() => new SandboxedTextCopyService({ sandboxExecutable: "sandbox-exec" }), /text_copy_configuration_invalid/u);
  assert.throws(() => new SandboxedTextCopyService({ limits: { timeoutMs: 0 } }), /text_copy_configuration_invalid/u);
  assert.throws(() => new SandboxedTextCopyService({ pdfPrefixArguments: ["bad\0argument"] }), /text_copy_configuration_invalid/u);
});

test("malformed UTF-8 HTML is refused without returning replacement text", async () => {
  const source = Buffer.concat([Buffer.from("<article>bad "), Buffer.from([0xc3, 0x28]), Buffer.from(" text</article>")]);
  const converted = await service().convert({ format: "html", sourceBytes: source });
  assert.equal(converted.status, "no_text_copy");
  assert.equal(converted.diagnosticCategory, "invalid_input");
  assert.equal(converted.markdownBytes.length, 0);
});

test("DOCX, PPTX, and audio are explicit not-supported-yet stubs", async () => {
  const converter = service();
  for (const format of ["docx", "pptx", "audio"] as const) {
    const converted = await converter.convert({ format, sourceBytes: bytes("opaque") });
    assert.equal(converted.status, "no_text_copy");
    assert.equal(converted.diagnosticCategory, "not_supported_yet");
    assert.equal(converted.converter.id, `control-room.${format}-stub`);
    assert.equal(converted.markdownBytes.length, 0);
  }
});

test("an unavailable PDF executable reports no text copy", async () => {
  const converter = new SandboxedTextCopyService({
    repositoryRoot: root,
    sandboxExecutable,
    pdfExecutable: join(root, "missing-pdftotext"),
  }, { spawnProcess: directSpawn(), skipNetworkDenialProbe: true, skipMemoryLimitProbe: true });
  const converted = await converter.convert({ format: "pdf", sourceBytes: bytes("%PDF-fixture") });
  assert.equal(converted.status, "no_text_copy");
  assert.equal(converted.diagnosticCategory, "converter_unavailable");
  const missingSandbox = new SandboxedTextCopyService({
    repositoryRoot: root,
    sandboxExecutable: join(root, "missing-sandbox-exec"),
  });
  const sandboxResult = await missingSandbox.convert({ format: "html", sourceBytes: bytes("<article>Text</article>") });
  assert.equal(sandboxResult.diagnosticCategory, "sandbox_unavailable");
});

test("timeout kills the converter's complete process group", async () => {
  const token = `acr-convert-timeout-${randomUUID()}`;
  const sentinel = join("/tmp", token);
  await rm(sentinel, { force: true });
  const converter = service({ limits: { timeoutMs: 80 } });
  const started = Date.now();
  const converted = await converter.convert({ format: "pdf", sourceBytes: bytes(`HANG:${token}`) });
  assert.equal(converted.diagnosticCategory, "timeout");
  assert.ok(Date.now() - started < 700, "the configured wall-clock timeout was not enforced");
  await new Promise(resolveWait => setTimeout(resolveWait, 550));
  assert.equal(await missing(sentinel), true, "a descendant survived the process-group timeout kill");
  await rm(sentinel, { force: true });
});

test("an abort stops a conversion halfway and retires its descendants", async () => {
  const token = `acr-convert-cancel-${randomUUID()}`;
  const sentinel = join("/tmp", token);
  await rm(sentinel, { force: true });
  const controller = new AbortController();
  const pending = service({ limits: { timeoutMs: 2_000 } }).convert({
    format: "pdf",
    sourceBytes: bytes(`SLOW:${token}`),
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 60);
  const converted = await pending;
  assert.equal(converted.diagnosticCategory, "cancelled");
  await new Promise(resolveWait => setTimeout(resolveWait, 550));
  assert.equal(await missing(sentinel), true);
  await rm(sentinel, { force: true });
});

test("a failed conversion can be retried and concurrent callers use isolated temp files", async () => {
  const converter = service();
  const failed = await converter.convert({ format: "pdf", sourceBytes: bytes("FAIL") });
  assert.equal(failed.diagnosticCategory, "conversion_failed");
  const retried = await converter.convert({ format: "pdf", sourceBytes: bytes("%PDF-retry succeeded") });
  assert.equal(retried.status, "succeeded");
  const [one, two] = await Promise.all([
    converter.convert({ format: "pdf", sourceBytes: bytes("%PDF-concurrent one") }),
    converter.convert({ format: "pdf", sourceBytes: bytes("%PDF-concurrent two") }),
  ]);
  assert.equal(text(one.markdownBytes), "Extracted PDF text: concurrent one\n");
  assert.equal(text(two.markdownBytes), "Extracted PDF text: concurrent two\n");
  assert.notEqual(one.sourceDigest, two.sourceDigest);
});

test("the source digest and bytes are detached from caller mutation", async () => {
  const source = Buffer.from("%PDF-original source");
  const pending = service().convert({ format: "pdf", sourceBytes: source });
  source.fill(0x78);
  const converted = await pending;
  assert.equal(converted.status, "succeeded");
  assert.equal(text(converted.markdownBytes), "Extracted PDF text: original source\n");
  assert.equal(converted.sourceDigest, "sha256:78210508c68641df9b61a03628da9cd08793452d16d9522710d98a390c28a9e2");
});

test("memory and markdown output bounds stop hostile converters", async () => {
  const simulatedRssSpawn = ((file: string, args: readonly string[], options: SpawnOptions) => {
    if (file === "/bin/ps") return spawn(process.execPath, ["-e", "console.log(999999)"], options);
    if (file === sandboxExecutable && args[0] === "-p") return spawn(args[2], args.slice(3), options);
    return spawn(file, args, options);
  }) as typeof spawn;
  const memoryConverter = new SandboxedTextCopyService({
    repositoryRoot: root,
    sandboxExecutable,
    nodeExecutable: process.execPath,
    pdfExecutable: process.execPath,
    pdfPrefixArguments: [fakePdf],
    limits: { memoryBytes: 8 * 1024 * 1024, timeoutMs: 2_000 },
  }, { spawnProcess: simulatedRssSpawn, skipNetworkDenialProbe: true });
  const memoryBound = await memoryConverter
    .convert({ format: "pdf", sourceBytes: bytes("BURN") });
  assert.equal(memoryBound.diagnosticCategory, "memory_limit");
  const outputBound = await service({ limits: { markdownBytes: 1_024 } })
    .convert({ format: "pdf", sourceBytes: bytes("BIG") });
  assert.equal(outputBound.diagnosticCategory, "output_too_large");
  const diagnosticBound = await service({ limits: { diagnosticBytes: 1_024 } })
    .convert({ format: "pdf", sourceBytes: bytes("CHATTER") });
  assert.equal(diagnosticBound.diagnosticCategory, "output_too_large");
  const invalidOutput = await service().convert({ format: "pdf", sourceBytes: bytes("INVALID_OUTPUT") });
  assert.equal(invalidOutput.diagnosticCategory, "conversion_failed");
  const symlinkOutput = await service().convert({ format: "pdf", sourceBytes: bytes("SYMLINK_OUTPUT") });
  assert.equal(symlinkOutput.diagnosticCategory, "conversion_failed");
});

test("an unavailable resident-memory monitor fails closed instead of running unbounded", async () => {
  const unavailableMonitorSpawn = ((file: string, args: readonly string[], options: SpawnOptions) => {
    if (file === "/bin/ps") throw Object.assign(new Error("process table unavailable"), { code: "EPERM" });
    if (file === sandboxExecutable && args[0] === "-p") return spawn(args[2], args.slice(3), options);
    return spawn(file, args, options);
  }) as typeof spawn;
  const converter = new SandboxedTextCopyService({
    repositoryRoot: root,
    sandboxExecutable,
    nodeExecutable: process.execPath,
    pdfExecutable: process.execPath,
    pdfPrefixArguments: [fakePdf],
    limits: { timeoutMs: 2_000 },
  }, { spawnProcess: unavailableMonitorSpawn, skipNetworkDenialProbe: true });
  const converted = await converter.convert({ format: "pdf", sourceBytes: bytes("BURN") });
  assert.equal(converted.diagnosticCategory, "resource_monitor_unavailable");
});

test("limits are stable public defaults", () => {
  assert.deepEqual(TEXT_COPY_LIMITS, {
    htmlInputBytes: 512 * 1024,
    pdfInputBytes: 32 * 1024 * 1024,
    markdownBytes: 2 * 1024 * 1024,
    diagnosticBytes: 16 * 1024,
    timeoutMs: 10_000,
    memoryBytes: 128 * 1024 * 1024,
  });
});
