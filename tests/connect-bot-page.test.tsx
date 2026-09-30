import assert from "node:assert/strict";
import test from "node:test";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { ConnectBotWorkspace, InstallLine, type ConnectBotInstallResult }
  from "../private-app/app/workers/connect/connect-bot-workspace";
import { createFleetOwnerHttpHandlerV1, fleetJoinCommandsV1 } from "../src/web/v1/fleet-owner-http";
import { FLEET_CONNECTOR_RELEASE_SCHEMA_V1, type FleetConnectorReleaseManifestV1 }
  from "../src/fleet/v1/connector-release";

const code = `crj_${"A".repeat(43)}`;
const workerId = `fleet-worker:${"d".repeat(32)}`;
const commandIdentity = Object.freeze({ displayName: "Desktop Codex", workerId });
const release: FleetConnectorReleaseManifestV1 = Object.freeze({ schema: FLEET_CONNECTOR_RELEASE_SCHEMA_V1,
  version: "0.3.0", file: "connector-0.3.0.mjs", sha256: "b".repeat(64), size: 1234, builtFrom: "c".repeat(40) });

function saveGlobals(keys: string[]) { return Object.fromEntries(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])); }
function restoreGlobals(saved: Record<string, PropertyDescriptor | undefined>) {
  for (const [key, descriptor] of Object.entries(saved)) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key];
  }
}

test("the owner page shows the exact versioned fleet command, including its current digest and chosen bot", () => {
  for (const [bot, os, command] of [["claude-code", "macos", "unix"], ["codex", "linux", "unix"],
    ["hermes", "windows", "windows"], ["cursor", "windows", "windows"], ["claude-desktop", "macos", "unix"],
    ["mcp-agent", "linux", "unix"]] as const) {
    const commands = fleetJoinCommandsV1("https://control.example.ts.net", code, bot, release, commandIdentity);
    const exact = commands[command];
    assert.equal(exact.includes("\n"), false);
    assert.match(exact, /connector-0\.3\.0\.mjs/u);
    assert.match(exact, /connector-manifest\.json/u);
    assert.match(exact, / b{64} 1234 c{40}/u);
    assert.match(exact, new RegExp(` install .*--bot ${bot} .*--name desktop-codex-d{12} .*--i-am-the-installer$`, "u"));
    assert.doesNotMatch(exact, /\sjoin\s/u);
    assert.equal(exact.slice(0, exact.indexOf(" --code ")).includes(code), false, `${os}: code before argument`);
    assert.equal([...exact.matchAll(/https?:\/\/[^ ']+/gu)].some(match => match[0].includes(code)), false, `${os}: code in URL`);
  }
  assert.throws(() => fleetJoinCommandsV1("https://control.example.ts.net", code, "wrong-kind", release, commandIdentity));
  assert.throws(() => fleetJoinCommandsV1("https://control.example.ts.net", "crj_short", "codex", release, commandIdentity));
  assert.throws(() => fleetJoinCommandsV1("https://control.example.ts.net", code, "codex", release,
    { displayName: "line\nbreak", workerId }));
  assert.throws(() => fleetJoinCommandsV1("https://control.example.ts.net", code, "codex", release,
    { displayName: "safe", workerId: "fleet-worker:short" }));
});

test("the connect-code route binds the chosen kind and returns only the current release command", async () => {
  const issued: unknown[] = [];
  const service = { createEnrollmentCode: async (_identity: unknown, input: unknown) => {
    issued.push(input);
    return { codeId: `fleet-code:${"a".repeat(32)}`, workerId: `fleet-worker:${"b".repeat(32)}`,
      code, workerKind: (input as { workerKind: string }).workerKind,
      displayName: (input as { displayName: string }).displayName, expiresAt: "2099-01-01T00:00:00.000Z" };
  } };
  const handler = createFleetOwnerHttpHandlerV1({ origin: "https://control.example", service: service as never,
    gatewayOrigin: "https://control.example.ts.net", connectorRelease: release,
    localOwnerSession: { assertLocalRequest() {}, verify() { return {}; } } as never });
  const post = (body: unknown) => handler(new Request("https://control.example/api/v1/fleet/connect-codes", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  const body = { botKind: "cursor", name: "<desktop> Ω", operatingSystem: "windows",
    projectIds: ["project:alpha"], capabilities: ["writing"] };
  const response = await post(body);
  assert.equal(response.status, 201);
  const value = await response.json() as { installLine: string; profileName: string; ownerNextStep: string;
    release: FleetConnectorReleaseManifestV1 };
  assert.deepEqual(value.release, release);
  const expected = fleetJoinCommandsV1("https://control.example.ts.net", code, "cursor", release,
    { displayName: body.name, workerId: `fleet-worker:${"b".repeat(32)}` });
  assert.equal(value.installLine, expected.windows);
  assert.equal(value.profileName, "desktop-bbbbbbbbbbbb");
  assert.match(value.ownerNextStep, /Cursor is registered.*Close and reopen Cursor.*no background service/u);
  assert.deepEqual(issued, [{ displayName: "<desktop> Ω", workerKind: "cursor", operatingSystem: "windows",
    projectIds: ["project:alpha"], capabilities: ["writing"] }]);
  for (const refused of [{ ...body, botKind: "other" }, { ...body, operatingSystem: "android" }, { ...body, extra: true }]) {
    const invalid = await post(refused);
    assert.equal(invalid.status, 400);
  }
});

test("the result says plainly when a code expired and disables copying it", async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true, url: "https://control.example/workers/connect" });
  const saved = saveGlobals(["window", "document", "IS_REACT_ACT_ENVIRONMENT"]);
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const result: ConnectBotInstallResult = { codeId: `fleet-code:${"a".repeat(32)}`,
    workerId: `fleet-worker:${"b".repeat(32)}`, expiresAt: "2000-01-01T00:00:00.000Z", operatingSystem: "macos",
    botKind: "codex", profileName: "safe-profile", ownerNextStep: "Codex is registered.", release, installLine: "safe line" };
  try {
    await act(async () => root.render(<InstallLine result={result} />));
    assert.match(dom.window.document.body.textContent ?? "", /This code expired\. Create a new code/u);
    assert.equal(dom.window.document.querySelector("button")?.disabled, true);
  } finally { await act(async () => root.unmount()); dom.window.close(); restoreGlobals(saved); }
});

test("at a 375px viewport, every picker is present and hostile display names remain text", async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true, url: "https://control.example/workers/connect" });
  Object.defineProperty(dom.window, "innerWidth", { value: 375, configurable: true });
  const saved = saveGlobals(["window", "document", "Event", "EventTarget", "HTMLElement", "HTMLInputElement",
    "HTMLSelectElement", "MouseEvent", "confirm", "fetch", "IS_REACT_ACT_ENVIRONMENT"]);
  Object.assign(globalThis, { window: dom.window, document: dom.window.document,
    Event: dom.window.Event, EventTarget: dom.window.EventTarget, HTMLElement: dom.window.HTMLElement,
    HTMLInputElement: dom.window.HTMLInputElement, HTMLSelectElement: dom.window.HTMLSelectElement,
    MouseEvent: dom.window.MouseEvent, confirm: () => true, IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.fetch = async (path, init) => {
    const value = String(path);
    if (value === "/api/v1/fleet") return Response.json({ workers: [{ workerId: `fleet-worker:${"c".repeat(32)}`,
      displayName: '<img src=x onerror=alert(1)> Ω', workerKind: "codex", status: "connected", lastSeenAt: null }], pendingCodes: [],
      results: [], connectBot: { available: true, release }, gatewayConfigured: true });
    if (value === "/api/v1/projects") return Response.json({ projects: [{ projectId: "project:alpha", title: "Alpha" }] });
    if (value.endsWith("/revoke")) return Response.json({ revoked: true });
    throw new Error(`unexpected fetch ${value}`);
  };
  const root = createRoot(dom.window.document.getElementById("root")!);
  try {
    await act(async () => { root.render(<ConnectBotWorkspace />); await new Promise(resolve => setTimeout(resolve, 0)); });
    assert.deepEqual([...dom.window.document.querySelectorAll('select[name="bot-kind"] option')].map(option => option.textContent),
      ["Claude Code", "Codex", "Hermes", "Cursor", "Claude Desktop", "Generic MCP"]);
    assert.equal(dom.window.document.querySelectorAll('input[name="operating-system"]').length, 3);
    assert.equal(dom.window.document.querySelector("img"), null, "an HTML display name stays text");
    assert.match(dom.window.document.body.textContent ?? "", /<img src=x onerror=alert\(1\)> Ω/iu);
  } finally { await act(async () => root.unmount()); dom.window.close(); restoreGlobals(saved); }
});
