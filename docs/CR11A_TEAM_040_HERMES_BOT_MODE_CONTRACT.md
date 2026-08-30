# CR11A-TEAM-040 read-only Hermes Bot Mode normalization contract

**Status:** Complete for the exact repository-only, injected-fixture boundary
**Decision date:** 2026-08-30
**Adapter:** `adapter.hermes.bot-mode.read.v1` at `1.0.0`
**Observation contract:** `control-room-hermes-bot-mode-observation/v1`
**Projection contract:** `control-room-hermes-bot-mode-projection/v1`

## Outcome

Control Room can normalize sanitized Hermes Bot Mode profile, routine, room, and safe-summary event observations into the existing Project Agent Team view. The adapter has no native reader, RPC client, process launcher, network client, provider client, schedule writer, messaging method, work materializer, approval method, dispatch method, or executor.

The only accepted source mode is `injected_only`. A fixture or later protected reader must hand the adapter an exact ordinary-data observation. TEAM-040 itself cannot locate a Hermes installation, inspect a profile, resolve a credential, read a conversation, contact a provider, or discover a device.

## Compatibility pin

Compatibility is bound to the already accepted Hermes Agent package `0.20.6` and exact revision `5fc308a70719a83cccdbba4c0e39c23f5a8239d5`. The required ordered read ceiling is:

1. profiles;
2. rooms;
3. routines; and
4. safe-summary events.

The allowed write set is empty. Version, revision, observation contract, source mode, ordered read set, write set, native-qualification truth, provider-sharing truth, and full-message-read truth are all checked. Drift is incompatible.

The Hermes Bot Mode guide, separate Bot Mode repository, and profile-routing guide remain design research context only. They are not an independently qualified runtime pin and cannot widen the accepted compatibility surface. TEAM-050 must separately prove any native method and identity it proposes to read.

## Strict injected observation

The input is a closed schema containing only:

- exact tenant, workspace, and project scope;
- digest-only profile, device, identity-evidence, schedule, room, event, and presence references;
- bounded display labels and safe summaries;
- explicit observed, absent, or unknown collection truth;
- exact negative-authority declarations; and
- the frozen Control Room resource ceilings.

Unknown fields fail. Accessors and known hostile Proxies fail before behavior runs. Secret-shaped values fail. Full-message, raw-prompt, memory, native-profile, provider-session, MCP-configuration, provider-output, shared-provider, write, schedule-creation, work-creation, approval, lease, command, dispatch, and execution claims cannot enter the schema.

An empty observed collection is a contradiction. `absent` and `unknown` require an empty collection and remain distinct in the projection. When profiles are absent or unknown, the adapter returns a safe projection with a null Team workspace rather than inventing an agent.

## Stable identity and scope

Each normalized Hermes agent identity is derived from the exact tenant, workspace, project, profile-key digest, and device-key digest. Device-disambiguated handles include a safe digest suffix. The projection retains only digest references and an explicit `injected_digest_attestation` basis.

Re-signing the outer projection cannot substitute a device while keeping the same normalized agent identity. Profile, presence, routine, room, event, member, author, and mention references must resolve inside the same project observation. Foreign scope and unknown identities fail closed.

TEAM-040 does not claim that a real device or profile has been authenticated. `nativeQualified` is always false. Native profile/device proof belongs only to a separately owner-authorized TEAM-050 attempt.

## Presence

Bot availability, recent room activity, an open desktop, and an animation never produce `working`.

`working` requires one exact injected Control Room presence record with:

- `active_lease` or `authenticated_heartbeat` basis;
- project and profile binding;
- a digest-only evidence reference;
- current work identity and safe summary;
- observation and expiry times; and
- a maximum lifetime of five minutes.

Expired evidence maps to `stale` with no current-work claim. An enabled profile without Control Room evidence is only `available`. A disabled profile is `offline`. Unknown profile state is `stale`. Presence for a disabled, foreign, unknown, future, or overlong identity fails.

## Routines and rooms

Routines normalize into the existing non-authorizing schedule projection. `scheduled` requires a next occurrence; disabled or unknown state cannot claim one. Unknown state maps conservatively to `blocked`. Every schedule remains observed-only and grants no command or execution authority.

Rooms normalize into the existing bounded War Room contract:

- two to six exact members;
- at most three rounds;
- at most ten safe-summary events;
- at most four reciprocal pair messages;
- at most thirty minutes;
- at most 100,000 reasoning units; and
- at most US$25.

Sequence, chronology, author, membership, mention, needs-owner, scope, and linked-work references are exact. Only safe summaries are admitted. Room output creates no handoff proposal, canonical work, audit replacement, approval, dispatch, lease, command, or provider authority.

## Projection and conformance

The output wraps the existing digest-bound Agent Team workspace, plus stable identity bindings, collection truth, observation digest, manifest digest, and an outer projection digest. Every layer is rechecked when parsed. Returned data is deeply frozen.

The conformance harness accepts only an exact frozen adapter with these three fields:

- `manifest`;
- `evaluateCompatibility`; and
- `normalizeObservation`.

Hidden methods, mutable or cyclic manifests, hostile compatibility results, accessor fixtures, Proxy fixtures, pin drift, malformed observations, authority substitution, digest drift, and normalization substitution fail closed. Conformance reports exact-pin, injected-only, safe-projection, resource-ceiling, and negative-authority checks. It performs no native or external action.

## Deferred boundary

TEAM-050 may either record a disabled disposition or perform one separately owner-authorized, one-profile/one-room native read qualification. It must freeze the exact native method set, create no write, read no full content, prove device and profile identity, sanitize before persistence, and retain all Control Room authority ceilings. TEAM-040 grants no permission for that attempt.
