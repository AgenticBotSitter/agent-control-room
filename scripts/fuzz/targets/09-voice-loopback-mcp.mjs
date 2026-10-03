// Voice transcripts (browser SpeechRecognition events through the real adapter and the policy
// helpers), the private loopback length-prefixed frame decoder (the connector enrollment path), and
// the Hermes Desktop MCP/JSON-RPC bridge fed with fuzzed connector replies.
import { safeStringify } from "../lib/rng.mjs";
import { types } from "node:util";
import { dedupeTranscriptEventsV1, canReadAloudV1 } from "../../../src/voice/v1/policy.ts";
import { voiceBrowserAdaptersV1 } from "../../../private-app/app/voice-browser-adapters.ts";
import { ConnectionEnrollmentPrivateLoopbackFrameDecoderV1, ConnectionEnrollmentPrivateLoopbackFramingErrorV1 } from "../../../src/connection-registry/v1/private-loopback-framing.ts";
import { IdeaLabHermes021FixedRpcBridgeV1, IDEA_LAB_HERMES_021_FIXED_RPC_SOURCE_MANIFEST_DIGEST_V1 } from "../../../src/idea-lab/v1/hermes-021-fixed-rpc-bridge.ts";
import { IDEA_LAB_HERMES_021_REVISION_V1, IDEA_LAB_HERMES_021_VERSION_V1 } from "../../../src/idea-lab/v1/hermes-021-panel-packet.ts";
import { IDEA_LAB_HERMES_021_CONNECTION_SAFE_RESULT_V1 } from "../../../src/idea-lab/v1/hermes-021-enrolled-connection.ts";
import { IdeaLabErrorV1 } from "../../../src/idea-lab/v1/errors.ts";
import { createHostCancellationControllerV1, createHostResultCollectorV1 } from "../../../src/security/host-value.ts";

// --- voice ------------------------------------------------------------------------------
const transcriptEvents = () => [{ eventId: "recognition-0-0", transcript: "hello", isFinal: true }, { eventId: "recognition-0-1", transcript: "world", isFinal: true }];
function runAdapter(resultsEvent) {
  const captured = [], errors = []; let engine;
  class FakeRecognition { start() {} stop() {} abort() {} }
  const previous = globalThis.SpeechRecognition;
  globalThis.SpeechRecognition = FakeRecognition;
  try {
    const { recognition } = voiceBrowserAdaptersV1();
    const origStart = FakeRecognition.prototype.start;
    FakeRecognition.prototype.start = function () { engine = this; origStart.call(this); };
    recognition.start({ onEvent: e => captured.push(e), onError: (k, m) => errors.push({ k, m }) });
    engine.onresult?.(resultsEvent);
    recognition.stop();
  } finally { if (previous === undefined) delete globalThis.SpeechRecognition; else globalThis.SpeechRecognition = previous; }
  return { captured, errors };
}

// --- loopback framing ----------------------------------------------------------------------
const configuration = () => ({ listenerId: "private-loopback-listener:abc-123", transport: "ssh_tunnel", listenerVisibility: "private_loopback", addressFamily: "ipv4", bindAddress: "127.0.0.1", framing: "uint32-be-utf8-single-frame/v1", maximumFrameBytes: 65_536, maximumChunks: 64 });
const deliver = () => ({ protocol: "control-room-node/v1", direction: "to_controller", messageId: "msg-1", correlationId: "corr-1", tenantId: "tenant:1", actorId: "actor:1", senderKind: "node", keyId: "key:1", connectionId: "conn:1", sequence: 1, sentAt: "2026-10-02T09:00:00.000Z", expiresAt: "2026-10-02T09:05:00.000Z", nonce: "n", bodyDigest: `sha256:${"0".repeat(64)}`, signature: "s", type: "connection.enrollment.deliver", body: { deliveryId: "delivery-1", enrollmentContract: "c", envelopeDigest: `sha256:${"1".repeat(64)}`, envelope: { a: 1 } } });
const frameOf = (text, declared) => { const bytes = Buffer.from(text, "utf8"); const header = Buffer.alloc(4); header.writeUInt32BE(declared ?? bytes.length, 0); return Buffer.concat([header, bytes]); };
function splitChunks(rng, buffer) { const chunks = []; let at = 0; while (at < buffer.length) { const n = rng.int(1, Math.max(1, Math.min(buffer.length - at, 4096))); chunks.push(new Uint8Array(buffer.subarray(at, at + n))); at += n; } return chunks; }

// --- MCP bridge --------------------------------------------------------------------------
const digest = c => `sha256:${c.repeat(64)}`;
const executeInput = signal => ({ connectionContractVersion: IDEA_LAB_HERMES_021_CONNECTION_SAFE_RESULT_V1, connectionId: "conn:1", transport: "local_loopback", connectorRouteDigest: digest("a"), attemptId: "attempt:1", permitDigest: digest("b"), markerDigest: digest("c"), participantId: "participant:1", participantIdentityDigest: digest("d"), round: 1, safeInstruction: "Give one safe opinion.", runtimeIdentityDigest: digest("e"), profileIdentityDigest: digest("f"), conversationIdentityDigest: digest("1"), maximumOutputCharacters: 800, toolsEnabled: false, mcpEnabled: false, pluginsEnabled: false, genericShellEnabled: false, signal });
const replies = () => ({
  open: { contractVersion: "control-room-hermes-021-fixed-route-open/v1", attemptId: "attempt:1", permitDigest: digest("b"), connectorRouteDigest: digest("a"), routeLeaseDigest: digest("2"), runtimeVersion: IDEA_LAB_HERMES_021_VERSION_V1, runtimeRevision: IDEA_LAB_HERMES_021_REVISION_V1, sourceManifestDigest: IDEA_LAB_HERMES_021_FIXED_RPC_SOURCE_MANIFEST_DIGEST_V1, profileIdentityDigest: digest("f"), conversationIdentityDigest: digest("1"), endpointVisibility: "connector_private_loopback", nativeLocatorReturned: false, toolsDisabled: true, mcpDisabled: true, pluginsDisabled: true },
  "session.create": { contractVersion: "control-room-hermes-021-fixed-operation-result/v1", sessionIdentityDigest: digest("3"), epochDigest: digest("4"), operation: "session.create", status: "created", conversationIdentityDigest: digest("1"), providerCalls: 0 },
  "prompt.submit": { contractVersion: "control-room-hermes-021-fixed-operation-result/v1", sessionIdentityDigest: digest("3"), epochDigest: digest("4"), operation: "prompt.submit", status: "accepted", providerCalls: 1 },
  "session.events.since": { contractVersion: "control-room-hermes-021-fixed-operation-result/v1", sessionIdentityDigest: digest("3"), epochDigest: digest("4"), operation: "session.events.since", status: "replayed", truncated: false, latestSequence: 3, events: [{ sequence: 1, type: "message.start" }, { sequence: 2, type: "message.delta" }, { sequence: 3, type: "message.complete", finalText: JSON.stringify({ safeOpinion: "Promising but unproven.", opportunityCode: "market_pull", primaryRiskCode: "distribution", suggestedExperiment: "Run a landing page test.", confidencePercent: 60 }) }] },
  "session.status": { contractVersion: "control-room-hermes-021-fixed-operation-result/v1", sessionIdentityDigest: digest("3"), epochDigest: digest("4"), operation: "session.status", status: "settled", providerCalls: 1 },
  "session.usage": { contractVersion: "control-room-hermes-021-fixed-operation-result/v1", sessionIdentityDigest: digest("3"), epochDigest: digest("4"), operation: "session.usage", status: "settled", inputUnits: 10, outputUnits: 20, reasoningUnits: 5, totalUnits: 35, calls: 1, costUsd: 0.01 },
  "session.interrupt": { contractVersion: "control-room-hermes-021-fixed-operation-result/v1", sessionIdentityDigest: digest("3"), epochDigest: digest("4"), operation: "session.interrupt", status: "interrupted", providerCalls: 1 },
  "session.close": { contractVersion: "control-room-hermes-021-fixed-operation-result/v1", sessionIdentityDigest: digest("3"), epochDigest: digest("4"), operation: "session.close", status: "closed", providerCalls: 1 },
  close: { contractVersion: "control-room-hermes-021-fixed-route-close/v1", attemptId: "attempt:1", permitDigest: digest("b"), connectorRouteDigest: digest("a"), nativeSessionClosed: true, routeLeaseReleased: true, disposableProfileRemoved: true, disposableWorkspaceRemoved: true, retainedNativeReferenceCount: 0 },
});
function connectorWith(table, behaviours) {
  const log = [];
  const reply = (name, collector) => { log.push(name); const b = behaviours[name]; if (b === "throw") throw new Error("connector exploded"); if (b === "silent") return; if (b === "twice") { collector.submit(table[name]); collector.submit(table[name]); return; } collector.submit(table[name]); };
  return { log, connector: { async openFixedRoute(input, collector) { reply("open", collector); }, async requestFixedOperation(input, collector) { reply(input.operation, collector); }, async closeFixedRoute(input, collector) { reply("close", collector); } } };
}

export const targets = [
  {
    name: "voice:transcripts",
    corpus: [transcriptEvents()],
    corpusInput: events => ({ kind: "dedupe", events }),
    generate(rng, c, i) {
      const r = rng.float();
      if (r < 0.4) return { $label: "dedupe", $input: { kind: "dedupe", events: rng.bool(0.8) ? rng.mutate(c[0], rng.int(1, 4)) : rng.jsonValue(0, 3) } };
      if (r < 0.5) return { $label: "dedupe-big", $input: { kind: "dedupe", events: Array.from({ length: rng.int(1000, 100000) }, (_, i) => ({ eventId: rng.bool(0.5) ? "same" : `e${i}`, transcript: rng.nasty(8), isFinal: true })) } };
      if (r < 0.65) return { $label: "read-aloud", $input: { kind: "read", content: rng.mutate({ text: "Hello owner", isSecret: false, isHidden: false }, rng.int(1, 3)) } };
      const results = rng.weighted([[4, [[{ transcript: rng.nasty(40) }], [{ transcript: rng.nasty(40) }, { transcript: "alt" }]]], [1, { length: rng.pick(i < 300 ? [0, 1, 3, -1, 2 ** 31, 2 ** 32, 1e6, NaN, "3"] : [0, 1, 3, -1, NaN, "3", 2000]), 0: [{ transcript: "a" }], 1: null, 2: [{}] }], [1, rng.jsonValue(0, 4)], [1, null], [1, Object.create(null)], [1, new Proxy([], { get: (t, k) => k === "length" ? 2 : [{ transcript: "proxy" }] })]]);
      return { $label: "adapter-onresult", $input: { kind: "adapter", event: rng.bool(0.8) ? { results } : rng.pick([null, undefined, {}, { results: undefined }, "x", { results }]) } };
    },
    timeoutMs: 8000,
    invoke(input) {
      if (input.kind === "dedupe") return { outcome: "accepted", value: dedupeTranscriptEventsV1(input.events) };
      if (input.kind === "read") return { outcome: "accepted", value: canReadAloudV1(input.content) };
      return { outcome: "accepted", value: runAdapter(input.event) };
    },
    expectedErrors: () => false,
    oracle(input, result) {
      const v = result.value;
      if (input.kind === "dedupe") { const ids = v.map(e => e?.eventId); if (new Set(ids).size !== ids.length) return "duplicates survived dedupe"; if (Array.isArray(input.events) && v.length > input.events.length) return "dedupe produced more events than it got"; if (({}).polluted !== undefined) return "prototype polluted"; }
      if (input.kind === "read" && v === true && (input.content?.isSecret === true || input.content?.isHidden === true || typeof input.content?.text !== "string" || !input.content.text.trim())) return "read-aloud allowed secret/hidden/empty content";
      if (input.kind === "adapter") { for (const e of v.captured) { if (typeof e.transcript !== "string" || !e.transcript.length) return "adapter emitted a non-string/empty transcript"; if (!/^recognition-\d+-\d+$/u.test(e.eventId)) return "adapter emitted a foreign eventId"; } if (v.captured.length > 10_000) return `adapter emitted ${v.captured.length} events from one result`; }
    },
  },
  {
    name: "loopback-frame-decoder",
    corpus: [JSON.stringify(deliver())],
    corpusInput: text => ({ chunks: [new Uint8Array(frameOf(text))], config: configuration() }),
    generate(rng, c) {
      const r = rng.float(); const text = c[0];
      if (r < 0.3) { const mutated = rng.mutateText(text, rng.int(1, 3)); return { $label: "json-text", $input: { chunks: splitChunks(rng, frameOf(mutated)), config: configuration(), text: mutated } }; }
      if (r < 0.5) { const mutated = safeStringify(rng.mutate(JSON.parse(text), rng.int(1, 3))) ?? "null"; return { $label: "json-value", $input: { chunks: splitChunks(rng, frameOf(mutated)), config: configuration(), text: mutated } }; }
      if (r < 0.65) { const declared = rng.pick([0, 1, 2, 3, Buffer.byteLength(text) - 1, Buffer.byteLength(text) + 1, 65_536, 65_537, 2 ** 32 - 1, 2 ** 31]); return { $label: "length-prefix", $input: { chunks: splitChunks(rng, frameOf(text, declared)), config: configuration(), text, declared } }; }
      if (r < 0.75) { const frame = frameOf(text); const extra = Buffer.concat([frame, Buffer.from(rng.bytes(rng.int(1, 100)))]); return { $label: "trailing", $input: { chunks: splitChunks(rng, extra), config: configuration(), text, trailing: true } }; }
      if (r < 0.85) { const bytes = Buffer.from(text, "utf8"); const i = rng.int(0, bytes.length - 1); bytes[i] = rng.pick([0xff, 0xc0, 0xed, 0x80, 0xf5]); return { $label: "utf8", $input: { chunks: splitChunks(rng, Buffer.concat([frameOf("").subarray(0, 0), (() => { const h = Buffer.alloc(4); h.writeUInt32BE(bytes.length, 0); return Buffer.concat([h, bytes]); })()])), config: configuration(), text: null } }; }
      if (r < 0.93) return { $label: "config", $input: { chunks: [new Uint8Array(frameOf(text))], config: rng.mutate(configuration(), rng.int(1, 3)), text } };
      const chunks = []; const n = rng.int(1, 80); for (let i = 0; i < n; i++) chunks.push(rng.weighted([[6, rng.bytes(rng.int(0, 8))], [1, "str"], [1, null], [1, new Uint16Array(2)], [1, Buffer.from("x")]]));
      return { $label: "chunks", $input: { chunks, config: configuration(), text: null } };
    },
    invoke(input) {
      const decoder = new ConnectionEnrollmentPrivateLoopbackFrameDecoderV1(input.config);
      try { for (const chunk of input.chunks) decoder.push(chunk); const frame = decoder.finish(); return { outcome: "accepted", value: frame }; }
      finally { decoder.close(); }
    },
    expectedErrors: e => e instanceof ConnectionEnrollmentPrivateLoopbackFramingErrorV1,
    oracle(input, result) {
      if (result.outcome !== "accepted") return undefined;
      const frame = result.value;
      if (input.trailing) return "accepted a frame with trailing bytes";
      if (input.declared !== undefined && input.declared !== Buffer.byteLength(input.text)) return "accepted a wrong length prefix";
      const joined = Buffer.concat(input.chunks.filter(c => c instanceof Uint8Array).map(c => Buffer.from(c)));
      if (joined.length !== 4 + frame.frameBytes) return "frameBytes disagrees with bytes consumed";
      let parsed; try { parsed = JSON.parse(frame.rawFrame); } catch { return "accepted non-JSON rawFrame"; }
      if (parsed?.type !== "connection.enrollment.deliver" || parsed?.body?.deliveryId !== frame.deliveryId) return "accepted a frame whose routing does not match";
      if (/"(\w+)"\s*:[\s\S]*"\1"\s*:/u.test(frame.rawFrame) && new Set(Object.keys(parsed)).size < (frame.rawFrame.match(/"[A-Za-z]+"\s*:/gu) ?? []).length - Object.keys(parsed.body ?? {}).length - 0) { /* heuristic only */ }
      if (frame.grantsApproval !== false || frame.grantsExecutionAuthority !== false) return "frame grants authority";
      if (input.chunks.length > input.config.maximumChunks) return "accepted more chunks than the maximum";
    },
  },
  {
    name: "mcp-bridge-replies",
    corpus: [replies()],
    corpusInput: table => ({ table, behaviours: {} }),
    generate(rng, c) {
      const table = structuredClone(c[0]); const behaviours = {}; const names = Object.keys(table);
      const n = rng.int(1, 3); const label = [];
      for (let i = 0; i < n; i++) {
        const name = rng.pick(names); const op = rng.int(0, 9);
        if (op <= 5) { table[name] = rng.mutate(table[name], rng.int(1, 3)); label.push(`${name}:mutate`); }
        else if (op === 6) { behaviours[name] = rng.pick(["throw", "silent", "twice"]); label.push(`${name}:${behaviours[name]}`); }
        else if (op === 7) { table[name] = rng.jsonValue(0, 4); label.push(`${name}:random`); }
        else if (op === 8 && name === "session.events.since" && Array.isArray(table[name]?.events)) { const ev = table[name].events; ev.splice(rng.int(0, ev.length), 0, rng.pick([{ sequence: rng.int(0, 5), type: rng.pick(["message.start", "message.complete", "error", "x"]), finalText: rng.nasty(30), safeCode: rng.pick(["boom", "x", "ok_code"]) }, { sequence: 2, type: "message.delta", extra: 1 }])); label.push("events:insert"); }
        else if (table[name] && typeof table[name] === "object") { try { table[name] = new Proxy(structuredClone(table[name]), {}); label.push(`${name}:proxy`); } catch { label.push(`${name}:proxy-skip`); } }
      }
      if (rng.bool(0.15)) { const t = table["session.events.since"]; if (t?.events?.[2] && typeof t.events[2] === "object" && !types.isProxy(t.events[2])) { t.events[2].finalText = safeStringify(rng.mutate(JSON.parse(c[0]["session.events.since"].events[2].finalText), rng.int(1, 3))); label.push("panel:mutate"); } }
      return { $label: label.join("+"), $input: { table, behaviours } };
    },
    async invoke({ table, behaviours }) {
      const { connector, log } = connectorWith(table, behaviours);
      const bridge = new IdeaLabHermes021FixedRpcBridgeV1(connector);
      const controller = createHostCancellationControllerV1();
      const handoff = createHostResultCollectorV1();
      const input = executeInput(controller.signal);
      let frames, executeError;
      try { await bridge.executeFixedSession(input, handoff.collector); frames = handoff.take(); } catch (error) { executeError = error; }
      const cleanup = createHostResultCollectorV1(); let cleanupError, cleanupResult;
      try { await bridge.cleanupFixedSession({ connectionId: input.connectionId, connectorRouteDigest: input.connectorRouteDigest, attemptId: input.attemptId, permitDigest: input.permitDigest, markerDigest: input.markerDigest, signal: createHostCancellationControllerV1().signal }, cleanup.collector); cleanupResult = cleanup.take(); } catch (error) { cleanupError = error; }
      for (const e of [executeError, cleanupError]) if (e && !(e instanceof IdeaLabErrorV1)) throw e;
      return { outcome: frames ? "accepted" : "refused", value: { frames, executeError: executeError?.safeCode, cleanupError: cleanupError?.safeCode, cleanupResult, log } };
    },
    expectedErrors: () => false,
    oracle({ table, behaviours }, result) {
      const v = result.value;
      if (v.executeError && !["invalid_input", "integrity_failed", "authorization_denied", "redaction_rejected", "state_conflict"].includes(v.executeError)) return `unexpected safe code ${v.executeError}`;
      if (result.outcome !== "accepted") return undefined;
      const original = replies();
      const frames = v.frames?.frames; if (!Array.isArray(frames) || frames.length !== 4) return "completed session with wrong frame count";
      const panel = frames[1];
      if (panel.type === "panel.result") {
        const p = panel.payload; if (!(Number.isInteger(p.confidencePercent) && p.confidencePercent >= 0 && p.confidencePercent <= 100) || typeof p.safeOpinion !== "string" || p.safeOpinion.length > 800 || /[\u0000-\u001f]/u.test(p.safeOpinion + p.suggestedExperiment)) return "panel result with out-of-contract payload";
        if (Object.keys(p).sort().join(",") !== "confidencePercent,opportunityCode,primaryRiskCode,safeOpinion,suggestedExperiment") return "panel result with extra keys";
      }
      for (const name of ["open", "session.create", "prompt.submit", "session.status", "session.usage"]) { if (behaviours[name] === "throw" || behaviours[name] === "silent") return `session completed although ${name} ${behaviours[name]}`; }
      const open = table.open; if (open?.attemptId !== original.open.attemptId || open?.permitDigest !== original.open.permitDigest || open?.sourceManifestDigest !== original.open.sourceManifestDigest || open?.toolsDisabled !== true || open?.mcpDisabled !== true) return "completed with an open reply whose binding/tool flags differ";
      const usage = table["session.usage"]; if (usage?.totalUnits !== (usage?.inputUnits ?? 0) + (usage?.outputUnits ?? 0) + (usage?.reasoningUnits ?? 0)) return "completed with inconsistent usage";
      const ev = table["session.events.since"]?.events; if (!Array.isArray(ev) || ev.some((e, i) => e?.sequence !== i + 1)) return "completed with non-contiguous events";
      if (table["session.status"]?.status !== "settled") return "completed with unsettled status";
      if (frames[3]?.payload?.status !== "settled") return "final frame not settled";
    },
  },
];
