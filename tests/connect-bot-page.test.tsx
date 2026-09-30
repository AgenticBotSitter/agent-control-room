import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { ConnectBotWorkspace, InstallLine, type ConnectBotInstallResult }
  from "../private-app/app/workers/connect/connect-bot-workspace";
import { captureConnectBotRequestV1, captureConnectorManifestV1, connectBotInstallLineV1 }
  from "../src/web/v1/connect-bot-install-line";
import { createFleetOwnerHttpHandlerV1 } from "../src/web/v1/fleet-owner-http";

const code = `crj_${"A".repeat(43)}`;
const manifest = { path: "/fleet/v1/connector-0.3.0.mjs", sha256: `sha256:${"b".repeat(64)}` };

test("install lines are one line, digest-pinned, safely quoted for zsh/bash/PowerShell, and never put the code in a URL", async t => {
  for (const operatingSystem of ["macos", "linux", "windows"] as const) {
    const line = connectBotInstallLineV1({ gatewayOrigin: "https://control.example.ts.net", manifest,
      code, botKind: "claude-desktop", name: "desk.bot-1", operatingSystem });
    assert.equal(line.includes("\n"), false, operatingSystem);
    assert.match(line, /sha256:b{64}/u, operatingSystem);
    assert.match(line, /install --server .* --code .* --bot .* --name .* --i-am-the-installer/u, operatingSystem);
    assert.equal(line.slice(0, line.indexOf(" --code ")).includes(code), false, `${operatingSystem}: code before argument`);
    assert.equal([...line.matchAll(/https?:\/\/[^ ']+/gu)].some(match => match[0].includes(code)), false,
      `${operatingSystem}: code in URL`);
    if (operatingSystem !== "windows") {
      for (const shell of ["/bin/bash", "/bin/zsh"].filter(existsSync)) execFileSync(shell, ["-n", "-c", line]);
    } else {
      assert.match(line, /^\$ErrorActionPreference='Stop';/u);
      assert.match(line, /if \(\$LASTEXITCODE -ne 0\) \{ exit \$LASTEXITCODE \}/u);
      assert.match(line, /Invoke-WebRequest .* -OutFile \$p/u);
    }
  }

  assert.throws(() => connectBotInstallLineV1({ gatewayOrigin: "https://control.example.ts.net", manifest,
    code, botKind: "codex", name: "bad name; Remove-Item", operatingSystem: "windows" }));
  assert.throws(() => connectBotInstallLineV1({ gatewayOrigin: "https://control.example.ts.net/path", manifest,
    code, botKind: "codex", name: "safe", operatingSystem: "linux" }));
  assert.throws(() => connectBotInstallLineV1({ gatewayOrigin: "http://control.example", manifest,
    code, botKind: "codex", name: "safe", operatingSystem: "linux" }));
  for (const changed of [
    { manifest: { ...manifest, path: "/fleet/v1/connector.mjs?code=bad" } },
    { manifest: { ...manifest, sha256: "sha256:short" } },
    { code: "crj_short" }, { botKind: "other" }, { operatingSystem: "android" },
  ]) assert.throws(() => connectBotInstallLineV1({ gatewayOrigin: "https://control.example.ts.net", manifest,
    code, botKind: "codex", name: "safe", operatingSystem: "linux", ...changed } as never));

  const validRequest = { botKind: "codex", name: "safe", operatingSystem: "linux",
    projectIds: ["project:alpha"], capabilities: ["writing"] };
  assert.deepEqual(captureConnectBotRequestV1(validRequest), { ...validRequest, maxConcurrent: 1 });
  for (const changed of [{ extra: true }, { name: "" }, { botKind: "other" }, { operatingSystem: "android" },
    { projectIds: "project:alpha" }, { capabilities: "writing" }])
    assert.throws(() => captureConnectBotRequestV1({ ...validRequest, ...changed }));
  for (const changed of [{ path: "/other.mjs" }, { sha256: "sha256:short" }])
    assert.throws(() => captureConnectorManifestV1({ ...manifest, ...changed }));
  assert.throws(() => createFleetOwnerHttpHandlerV1({ origin: "https://control.example", service: {} as never,
    localOwnerSession: {} as never, gatewayOrigin: "https://control.example" }), /connector_manifest_invalid/u);
  assert.throws(() => createFleetOwnerHttpHandlerV1({ origin: "https://control.example", service: {} as never,
    localOwnerSession: {} as never, gatewayOrigin: "http://control.example", connectorManifest: manifest }),
  /connector_gateway_invalid/u);

  // Execute the Unix line with a disposable home and fake downloader. The
  // downloaded file records argv only after the generated Node digest check.
  const root = await mkdtemp(join(tmpdir(), "connect-bot-line-")); t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin"), fixture = join(root, "fixture.mjs"), observed = join(root, "observed.json");
  await (await import("node:fs/promises")).mkdir(bin);
  await writeFile(fixture, "import{writeFileSync}from'node:fs';writeFileSync(process.env.CONNECT_BOT_OBSERVED,JSON.stringify(process.argv.slice(2)));\n");
  const digest = `sha256:${createHash("sha256").update(await readFile(fixture)).digest("hex")}`;
  const downloader = join(bin, "curl");
  await writeFile(downloader, "#!/bin/sh\nwhile [ \"$#\" -gt 0 ]; do if [ \"$1\" = \"-o\" ]; then shift; cp \"$CONNECT_BOT_FIXTURE\" \"$1\"; exit 0; fi; shift; done\nexit 2\n");
  await chmod(downloader, 0o700);
  const line = connectBotInstallLineV1({ gatewayOrigin: "https://control.example.ts.net",
    manifest: { ...manifest, sha256: digest }, code, botKind: "codex", name: "load-safe", operatingSystem: "linux" });
  execFileSync("/bin/bash", ["-c", line], { env: { ...process.env, HOME: root,
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`, CONNECT_BOT_FIXTURE: fixture, CONNECT_BOT_OBSERVED: observed } });
  assert.deepEqual(JSON.parse(await readFile(observed, "utf8")), ["install", "--server", "https://control.example.ts.net",
    "--code", code, "--bot", "codex", "--name", "load-safe", "--i-am-the-installer"]);
});

test("the result says plainly when a code expired and disables copying it", async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true, url: "https://control.example/workers/connect" });
  const saved = Object.fromEntries(["window", "document", "IS_REACT_ACT_ENVIRONMENT"]
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const result: ConnectBotInstallResult = { codeId: `fleet-code:${"a".repeat(32)}`,
    workerId: `fleet-worker:${"b".repeat(32)}`, expiresAt: "2000-01-01T00:00:00.000Z", operatingSystem: "macos",
    manifest, installLine: "safe line" };
  try {
    await act(async () => root.render(<InstallLine result={result} />));
    assert.match(dom.window.document.body.textContent ?? "", /This code expired\. Create a new code/u);
    assert.equal(dom.window.document.querySelector("button")?.disabled, true);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});

test("the page offers every bot and OS and removes one connected bot", async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true, url: "https://control.example/workers/connect" });
  const saved = Object.fromEntries(["window", "document", "confirm", "fetch", "IS_REACT_ACT_ENVIRONMENT"]
    .map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    confirm: () => true, IS_REACT_ACT_ENVIRONMENT: true });
  const calls: { path: string; body?: Record<string, unknown> }[] = [];
  let revokeAttempts = 0;
  let workers = [{ workerId: `fleet-worker:${"c".repeat(32)}`, displayName: "desk-codex", workerKind: "codex",
    status: "connected", lastSeenAt: "2026-09-29T12:00:00.000Z" }];
  globalThis.fetch = async (path, init) => {
    const value = String(path), body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: value, ...(body ? { body } : {}) });
    if (value === "/api/v1/fleet") return Response.json({ workers, pendingCodes: [], results: [],
      connectBot: { available: true, manifest }, gatewayConfigured: true });
    if (value === "/api/v1/projects") return Response.json({ projects: [{ projectId: "project:alpha", title: "Alpha" }] });
    if (value.endsWith("/revoke") && ++revokeAttempts === 1) return new Response(null, { status: 503 });
    if (value.endsWith("/revoke")) { workers = []; return Response.json({ revoked: true }); }
    throw new Error(`unexpected fetch ${value}`);
  };
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => { root.render(<ConnectBotWorkspace />); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.ok([...dom.window.document.querySelectorAll("button")].some(button => button.textContent === "Remove"));
    assert.deepEqual([...dom.window.document.querySelectorAll('select[name="bot-kind"] option')].map(option => option.textContent),
      ["Claude Code", "Codex", "Hermes", "Claude Desktop", "Cursor"]);
    assert.deepEqual([...dom.window.document.querySelectorAll('input[name="operating-system"]')]
      .map(input => input.parentElement?.textContent?.replaceAll(/\s+/gu, " ").trim()),
    ["macOSTerminal (zsh)", "WindowsPowerShell", "LinuxTerminal (bash)"]);
    const remove = [...dom.window.document.querySelectorAll("button")].find(button => button.textContent === "Remove")!;
    await act(async () => { remove.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.match(dom.window.document.body.textContent ?? "", /The bot was not removed\. Nothing changed/u);
    assert.ok([...dom.window.document.querySelectorAll("button")].some(button => button.textContent === "Remove"));
    await act(async () => { remove.click(); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.ok(calls.some(call => call.path === `/api/v1/fleet/workers/${encodeURIComponent(`fleet-worker:${"c".repeat(32)}`)}/revoke`));
    assert.equal(revokeAttempts, 2, "the owner can retry after a failed removal");
    assert.match(dom.window.document.body.textContent ?? "", /desk-codex was removed[\s\S]*No bots are connected yet/u);
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of Object.entries(saved)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});
