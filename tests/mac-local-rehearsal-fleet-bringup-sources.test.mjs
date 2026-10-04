import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// R4U-19b: `mac:up`'s "5/6 fleet connector release" step called
// build-fleet-connector.mjs without --release-trust, which that script always
// refuses ("Control Room connector build refused"), so no Mac-local host could
// ever start past step 5 of 6.
test("mac:up passes --release-trust to the fleet connector release build (R4U-19b)", () => {
  const source = readFileSync(new URL("../scripts/mac-local/up.mjs", import.meta.url), "utf8");
  const match = /run\(\["scripts\/build-fleet-connector\.mjs"[^\]]*\]\)/s.exec(source);
  assert.ok(match, "could not find the fleet connector release build invocation in up.mjs");
  assert.match(match[0], /--release-trust/);
});

// R4U-19c: the rehearsal setup script never wrote config/release-trust.json (which the
// build above and loadMacLocalFleetReleaseTrustV1 both require at that fixed path) and
// never created the two fleet logins (control_room_fleet / control_room_fleet_owner), so
// `pnpm mac:rehearsal up` could set up a database but `mac:up` could never reach a running
// host: step 5/6 refused for the trust file, then mac_local_fleet_roles_missing for the
// logins. This is a structural check (not a database run) so it reports in the fast "quick"
// lane; the real bring-up is proved end to end by the owner-browser-journey lane, which
// chains `mac:rehearsal up` -> `mac:up` on every run.
test("rehearsal setup writes release-trust.json and the two fleet logins (R4U-19c)", () => {
  const source = readFileSync(new URL("../scripts/mac-local/rehearsal/setup.ts", import.meta.url), "utf8");
  assert.match(source, /["'`]fleet_gateway_roles\.sql["'`]/, "fleet_gateway_roles.sql must be applied");
  assert.match(source, /release-trust\.json/, "config/release-trust.json must be written");
  assert.match(source, /control_room_fleet_gateway/, "the gateway login must be granted the gateway role");
  assert.match(source, /control_room_fleet_owner_authority/, "the owner login must be granted the owner-authority role");
  assert.match(source, /fleetGateway:\s*role\(/, "database-roles.json must record the fleetGateway connection");
  assert.match(source, /fleetOwner:\s*role\(/, "database-roles.json must record the fleetOwner connection");
});

// Discovered proving the above two reach a running host: once mac:up's own build step can
// succeed, it can only ever produce a bundle + manifest (no private signing key), never a
// signed connector-release.json (written solely by the separate owner-attended `release:sign`
// step). The fleet gateway correctly refuses to start without one, but mac:up's gateway
// start previously treated that refusal as fatal and tore down the already-running web host
// too -- even though the web host's own connector loader documents an unsigned/absent release
// as an allowed web-only state. mac:up must extend it the same tolerance.
test("mac:up tolerates a fleet gateway that refuses for lack of a signed connector release", () => {
  const source = readFileSync(new URL("../scripts/mac-local/up.mjs", import.meta.url), "utf8");
  // Both strings are declared ONCE, in stack.mjs, so the gateway that writes them
  // and mac:up that reads them cannot drift apart. mac:up must reach the refusal
  // through that shared declaration, not through a copied literal.
  assert.match(source, /MAC_LOCAL_CONNECTOR_RELEASE_MISSING_V1/,
    "mac:up must recognize the gateway's specific missing-release refusal");
  const stack = readFileSync(new URL("../scripts/mac-local/stack.mjs", import.meta.url), "utf8");
  const gateway = readFileSync(new URL("../scripts/mac-local/start-fleet-gateway.mjs", import.meta.url), "utf8");
  assert.match(stack, /MAC_LOCAL_CONNECTOR_RELEASE_MISSING_V1 = "mac_local_fleet_connector_release_missing"/,
    "the tolerated refusal and the one the gateway throws must be the same declared string");
  assert.match(gateway, /throw new Error\(MAC_LOCAL_CONNECTOR_RELEASE_MISSING_V1\)/,
    "the gateway must throw the declared refusal, not a literal that can drift");
  const gatewayBlock = /async function startFleetGatewayForOwnerV1\([\s\S]*?\n\}/.exec(source)?.[0];
  assert.ok(gatewayBlock, "could not find the gateway start function in up.mjs");
  assert.match(gatewayBlock, /classifyGatewayLogV1\(/,
    "mac:up must classify the gateway's own error lines, not search the whole log for a substring");
  assert.match(gatewayBlock, /subarray\(/,
    "only the bytes this attempt wrote may be inspected; the log is never truncated");
  assert.match(gatewayBlock, /throw error;/,
    "any other gateway failure must still be fatal");
});
