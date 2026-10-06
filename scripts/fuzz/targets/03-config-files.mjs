// Config JSON files read from disk: product configuration, updater configuration, passkey config,
// rehearsal config, owner web push config, local owner session profile, nightly backup, release trust,
// trusted runtime inventory, known-good pairs, self-update flag, updater status, canonical JSON.
import { readFileSync } from "node:fs";
import { generateKeyPairSync } from "node:crypto";
import { parseProductConfigurationV1, PRODUCT_CONFIGURATION_MODULES_V1 } from "../../../src/config/v1/product-configuration.ts";
import { parseUpdaterConfigurationV1 } from "../../../src/updater/v1/updater.mjs";
import { parsePasskeyConfigV1 } from "../../../src/updater/v1/passkey.mjs";
import { parseRehearsalConfigV1 } from "../../../src/updater/v1/rehearsal/config.mjs";
import { captureOwnerWebPushConfigV1 } from "../../../src/web-push/v1/config.ts";
import { captureLocalOwnerSessionProfileV1 } from "../../../src/web/v1/local-owner-session.ts";
import { parseNightlyBackupConfigurationV1, createNightlyBackupConfigurationV1 } from "../../../src/installer/v1/nightly-backup-configuration.ts";
import { captureReleaseTrustV1, releaseKeyIdV1, RELEASE_TRUST_SCHEMA_V1 } from "../../../scripts/release-signing.mjs";
import { validateTrustedRuntimeManifest } from "../../../src/updater/v1/trusted-runtime.mjs";
import { parseKnownGoodV1, parseSelfUpdateFlagV1, publicStatusV1 } from "../../../src/updater/v1/contracts.mjs";
import { canonicalJsonV1 } from "../../../src/updater/v1/canonical-json.mjs";
import { pairV1 } from "../../../src/updater/v1/release-layout.mjs";

const ROOT = "/Library/Application Support/Control Room";
const releaseKeys = generateKeyPairSync("ed25519");
const publicKey = releaseKeys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
const inventory = JSON.parse(readFileSync(new URL("../../../src/updater/v1/policy/runtime-inventory.json", import.meta.url), "utf8"));

const corpus = {
  "product-configuration": () => ({ schema: "control-room.product-configuration/v1", displayName: "Control Room", defaultTimezone: "Europe/London",
    modules: { ideaLab: true, news: true, sessionObservations: false }, limits: { maxProjects: 10, maxTasksPerProject: 100, maxResultsPerTask: 10, maxArticleSources: 5, maxIdeaParticipants: 3 },
    projectTemplates: [{ id: "research", displayName: "Research", enabledModules: [...PRODUCT_CONFIGURATION_MODULES_V1].filter(m => m !== "sessionObservations") }] }),
  "updater-configuration": () => ({ schema: "control-room.updater-configuration/v1", database: { host: `${ROOT}/pg/socket`, port: 5432, name: "control_room", user: "control_room_deployer" } }),
  "passkey-config": () => ({ installationId: "inst-1", rpId: "control.example.com", expectedOrigin: "https://control.example.com" }),
  "rehearsal-config": () => ({ schema: "control-room.updater-rehearsal-config/v1", mode: "throwaway", rehearsalRoot: "/private/tmp/control-room-rehearsal-abc",
    rehearsalHostname: "rehearsal-abc.control-room.test", expectedOrigin: "https://rehearsal-abc.control-room.test:8444", ports: { web: 8444, gateway: 8445, postgres: 5444 },
    accounts: { service: "_crrehearsalsvc", database: "_crrehearsaldb", builder: "_crrehearsalbld" }, daemonLabelPrefix: "xyz.agentcontrolroom.rehearsal.abc", allowRealRoot: false }),
  "owner-web-push-config": () => ({ schema: "control-room.owner-web-push-config/v1", subject: "mailto:owner@example.com", publicKey: "B".repeat(87), privateKey: "a".repeat(43) }),
  "local-owner-session-profile": () => ({ schema: "control-room.local-owner-session/v1", origin: "http://127.0.0.1:3310", tenantId: "tenant:1", provider: "local-owner", subject: "owner", ownerCodeDigest: `sha256:${"a".repeat(64)}`, sessionSeconds: 3600, trustedOrigin: "https://control.example.com", remoteOrigins: ["https://remote.example.com"] }),
  "nightly-backup": () => createNightlyBackupConfigurationV1("/Library/Application Support/Control Room"),
  "release-trust": () => ({ schema: RELEASE_TRUST_SCHEMA_V1, epoch: 1, keyId: releaseKeyIdV1(publicKey), publicKey, versionFloor: "0.5.0", revokedKeyIds: [] }),
  "runtime-inventory": () => structuredClone(inventory),
  "known-good": () => ({ schema: "control-room.known-good/v1", count: 2, pairs: [{ releaseId: "r1", pgDataId: "d1", schemaDigest: `sha256:${"0".repeat(64)}` }, { releaseId: "r2", pgDataId: "d2", schemaDigest: `sha256:${"1".repeat(64)}` }] }),
  "updater-status": () => ({ state: "idle", releaseId: "r1", lastHealthAt: "2026-10-02T00:00:00.000Z", needsYou: false, updaterRestartsLastHour: 1, selfUpdate: "On" }),
  "pair": () => ({ releaseId: "r1", pgDataId: "d1", schemaDigest: `sha256:${"0".repeat(64)}` }),
};
const parsers = {
  "product-configuration": parseProductConfigurationV1,
  "updater-configuration": v => parseUpdaterConfigurationV1(v, ROOT),
  "passkey-config": parsePasskeyConfigV1,
  "rehearsal-config": parseRehearsalConfigV1,
  "owner-web-push-config": captureOwnerWebPushConfigV1,
  "local-owner-session-profile": captureLocalOwnerSessionProfileV1,
  "nightly-backup": v => parseNightlyBackupConfigurationV1("/Library/Application Support/Control Room/Protected/config/backup.json", v),
  "release-trust": captureReleaseTrustV1,
  "runtime-inventory": validateTrustedRuntimeManifest,
  "known-good": parseKnownGoodV1,
  "updater-status": publicStatusV1,
  "pair": pairV1,
};
const oracles = {
  "product-configuration": (input, v) => {
    const ids = v.projectTemplates.map(t => t.id);
    if (new Set(ids).size !== ids.length) return "duplicate template ids accepted";
    if (!ids.includes("control-room")) return "canonical self template missing";
    if (v.projectTemplates.some(t => t.enabledModules.some(m => !v.modules[m]))) return "template enables a disabled module";
    if (ids.some((id, i) => i && ids[i - 1].localeCompare(id) > 0)) return "templates not sorted";
    if (/[\u0000-\u001f]/u.test(v.displayName)) return "control char in displayName";
  },
  "updater-configuration": (input, v) => v.database.host !== `${ROOT}/pg/socket` || v.database.user !== "control_room_deployer" ? "non-canonical database wiring accepted" : undefined,
  "passkey-config": (input, v) => { const u = new URL(v.expectedOrigin); if (u.protocol !== "https:" || u.hostname !== v.rpId || (u.port && v.rehearsal !== true)) return "origin/rpId mismatch accepted"; if (/[A-Z]/u.test(v.rpId)) return "uppercase rpId accepted"; },
  "rehearsal-config": (input, v) => v.rehearsalRoot.startsWith("/Library/Application Support/Control Room") || v.rehearsalRoot === "/" ? "live root accepted" : (v.expectedOrigin !== `https://${v.rehearsalHostname}:${v.ports.web}` ? "origin mismatch accepted" : undefined),
  "owner-web-push-config": (input, v) => !/^mailto:[^\s@]+@[^\s@]+$/u.test(v.subject) || v.privateKey.length < 40 ? "bad VAPID shape accepted" : undefined,
  "local-owner-session-profile": (input, v) => { const o = new URL(v.origin); if (o.hostname !== "127.0.0.1" || o.protocol !== "http:") return "non-loopback origin accepted"; if (v.trustedOrigin && !v.trustedOrigin.startsWith("https://")) return "non-https trusted origin accepted"; if (v.remoteOrigins?.some(r => !/^https:\/\//u.test(r) || r === v.origin)) return "bad remote origin accepted"; if (/[\p{Cc}\p{Cf}\p{Cs}]/u.test(v.tenantId + v.provider + v.subject)) return "hidden chars in identity accepted"; },
  "nightly-backup": (input, v) => JSON.stringify(input) !== JSON.stringify(v) && typeof input === "object" && input && Object.keys(input).length !== Object.keys(v).length ? "non-identical backup config accepted" : undefined,
  "release-trust": (input, v) => v.keyId !== releaseKeyIdV1(v.publicKey) || v.revokedKeyIds.includes(v.keyId) ? "trust with wrong/revoked key accepted" : undefined,
  "runtime-inventory": (input, v) => { if (v.artifacts.length !== 4 || new Set(v.artifacts.map(a => a.tool)).size !== 4) return "tool set wrong"; for (const a of v.artifacts) { if (!a.url.startsWith("https://")) return "non-https url"; if (!/^[a-f0-9]{64}$/u.test(a.archiveSha256) || !/^[a-f0-9]{64}$/u.test(a.executableSha256)) return "bad digest"; if (a.executableRelativePath.startsWith("/") || a.executableRelativePath.split("/").includes("..")) return "path escape"; if (a.publisherProof?.kind === "none" && a.tool === "postgresql") return "postgres without publisher proof"; } },
  "known-good": (input, v) => v.pairs.length < 1 || v.pairs.length > 3 || v.pairs.length !== input.count ? "pair count mismatch accepted" : undefined,
  "updater-status": (input, v) => v.updaterRestartsLastHour > 3 || v.updaterRestartsLastHour < 0 ? "restart count out of range" : (v.lastHealthAt !== null && !Number.isFinite(Date.parse(v.lastHealthAt)) ? "unparseable health time" : undefined),
  "pair": (input, v) => !/^[A-Za-z0-9._-]{1,80}$/u.test(v.releaseId) || !/^[A-Za-z0-9._-]{1,80}$/u.test(v.pgDataId) ? "unsafe id accepted" : undefined,
};

const expected = error => error instanceof Error && (/refused|invalid|_refused$|^updater_|^rehearsal_|^nightly_|^release_signing_refused|^owner_web_push|^invalid_local_owner|^runtime_inventory/u.test(error.message) || /ZodError/u.test(error.name) || error.name === "TrustedRuntimeRefusal" || error.name === "ReleaseSigningRefusal");

export const targets = [
  ...Object.keys(corpus).map(name => ({
    name: `config:${name}`,
    corpus: [corpus[name]()],
    generate(rng, c) {
      const r = rng.float();
      if (r < 0.85) return { $label: "mutate", $input: rng.mutate(c[0], rng.int(1, 4)) };
      if (r < 0.95) return { $label: "random", $input: rng.jsonValue(0, 5) };
      return { $label: "scalar", $input: rng.pick([null, undefined, 0, "", [], "{}", true, 1e400, Symbol.for("s"), () => 1, new Proxy({}, {}), Object.create(null)]) };
    },
    invoke(input) { return { outcome: "accepted", value: parsers[name](input) }; },
    expectedErrors: expected,
    oracle(input, result) { if (result.outcome !== "accepted") return undefined; return oracles[name]?.(input, result.value); },
  })),
  {
    name: "config:self-update-flag",
    corpus: ["On\n", "Off\n", "On", "Off"],
    generate(rng, c) { return rng.bool(0.5) ? rng.mutateText(rng.pick(c), 1) : rng.pick([" On", "On \n", "﻿On", "ON", "on", "On\n\n", "On\r\n", "Off ", "On\0", 1, null, ["On"]]); },
    invoke(input) { return { outcome: "accepted", value: parseSelfUpdateFlagV1(input) }; },
    expectedErrors: expected,
    oracle(input, result) { if (result.outcome === "accepted" && result.value === "On" && input !== "On" && input !== "On\n") return "accepted a non-exact On switch"; },
  },
  {
    name: "config:canonical-json",
    corpus: [{ b: 1, a: [1, "x", null, { z: true, y: 2 }] }],
    generate(rng, c) { const r = rng.float(); if (r < 0.5) return rng.mutate(c[0], rng.int(1, 3)); if (r < 0.8) return rng.jsonValue(0, 7); return rng.deepValue(rng.int(10, 3000)); },
    invoke(input) { return { outcome: "accepted", value: canonicalJsonV1(input) }; },
    expectedErrors: error => error instanceof Error && /updater_plan_json_refused/u.test(error.message) || error instanceof RangeError,
    oracle(input, result) {
      if (result.outcome !== "accepted") return undefined;
      let round; try { round = JSON.parse(result.value); } catch { return "canonical output is not valid JSON"; }
      if (canonicalJsonV1(round) !== result.value) return "canonical form is not a fixed point";
      if (/[\ud800-\udfff]/u.test(result.value) && !/\\u/u.test(result.value)) { try { new TextEncoder().encode(result.value); } catch { return "lone surrogate in canonical output"; } }
    },
  },
];
