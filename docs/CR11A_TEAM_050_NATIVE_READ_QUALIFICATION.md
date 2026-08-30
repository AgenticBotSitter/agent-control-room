# CR11A TEAM-050 native Hermes read qualification

**Status:** Blocked before the authorized native data attempt
**Date:** 2026-08-30
**Packet:** `cr11a-team-050-native-read-v1`
**Hermes pin:** package `0.20.6`, revision `5fc308a70719a83cccdbba4c0e39c23f5a8239d5`

## Owner-authorized ceiling

The owner authorized one sanitized, read-only Hermes qualification limited to one profile and one room. The frozen packet permits one attempt and no retry. It permits zero provider calls, writes, full-content reads, messages, schedule mutations, commands, installations, deployments, or other effects.

The authorization phrase is not retained. Repository evidence records only the fixed scope and its digest-bound result.

## Preparation evidence

Preparation inspected only the installed Hermes program and Git checkout. It did not start Hermes, call a Bot Mode RPC, read `profile.yaml`, enumerate profiles or rooms, contact a provider, or inspect profile content.

The installed checkout was clean and matched the accepted revision. The three source files that define the candidate reads matched these SHA-256 digests:

- `tui_gateway/methods_profiles.py`: `3846fdf832e3abab7fb3d9b1eafba629da2fd96ff39f9471964490df1697dca4`
- `apps/desktop/src/plugins/hermes-bots/plugin.js`: `a7b55bc825e2e5da162b72c56506c4d0f79bf90c2fd3f3af845225e34105357d`
- `hermes_cli/profiles.py`: `d2cd616cd80d8405dd756bf0a0f6f14dc0006e86a5cb7eb7498e8132d8941233`

## Candidate-method decision

| Candidate | What the pinned source does | Disposition |
|---|---|---|
| `profiles.list` with `include_sessions: false` | Enumerates every profile and returns path, model, provider, profile metadata, and the default profile's room mirror. The mirror includes bounded message text. | Rejected before call: broader than one profile and one room, includes prohibited data, and does not prove device identity. |
| `profiles.describe` for one name | Reads one profile's full SOUL text, model/provider configuration, skills, toolsets, and MCP server configuration. It does not provide a bounded one-room projection or device proof. | Rejected before call: full-content and configuration read. |
| Direct `profile.yaml` read | Can address one profile but its `ui_meta` room mirror can contain multiple rooms and recent message text. Filtering would occur only after prohibited content crossed the reader boundary. | Rejected before read: not one-room or sanitize-before-content. |

The installed pin exposes no method that returns exactly one selected profile and at most one selected room as metadata-only data before content crosses the Control Room boundary. Sanitizing an over-broad result after receipt would not satisfy the authorization.

## Frozen result

The machine-checked disposition is `blocked_before_attempt`.

- Authorized attempts: 1
- Attempts performed: 0
- Retries performed: 0
- Hermes runtime contacts: 0
- Profile records read: 0
- Room records read: 0
- Full-content reads: 0
- Provider calls: 0
- Writes, messages, schedule mutations, commands, installs, and deployments: 0
- Profile identity proved: no
- Device identity proved: no
- Temporary resources created: none
- Cleanup required: no

The unused attempt is not permission for a later retry. A future attempt requires a new exact packet and owner authorization after a metadata-only filtered method exists and is pinned.

## Required future read shape

A future Hermes method must accept one exact profile selector and an optional one-room selector. It must return only bounded presentation metadata and stable profile/device identity evidence. It must omit message text, prompts, memory, SOUL, configuration, native paths, provider/model details, sessions, credentials, MCP configuration, and every write or execution capability before the result crosses the native boundary.

The Control Room side must reject pin or method drift, sanitize before persistence, retain only digests and safe metadata, and preserve the empty provider/write set.
