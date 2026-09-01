# CR12B-IDEA-109B — enrolled Hermes connection acceptance

**Status:** Accepted for the exact repository-only, connection-disabled snapshot.

## Outcome

Control Room no longer depends on a Hermes source change to prepare an isolated Idea Lab profile. Exact review of the
installed Hermes revision `a2907a8bcdd8e5cdfbd9d6f7ec8b064ce7e40b5b` found the built-in boundary that IDEA-108
missed: a fresh no-skills profile can resolve a missing provider from the global-root protected-value pool by read-only,
per-provider fallback while all writes remain profile-local. The fresh profile copies no SOUL, memory, skills, plugins,
MCP configuration, rules, or sessions.

Hermes also already implements registered SSH connections, key-only batch operation, connect-on-demand Bot discovery,
and a combined multi-machine roster. Cross-gateway work remains explicit; Control Room is the bridge and does not turn
the shared roster into implicit execution authority.

## Reviewed source pins

| Source | SHA-256 |
|---|---|
| `hermes_cli/auth.py` | `98d96872425c1e4564fe6a5cc27731166266b1b6795d0187db1d42cf1c92b84e` |
| `hermes_cli/profiles.py` | `edeafa558cea28cc42ce4e80a21489a3176454a48bae9f767d8c179b954e0981` |
| `apps/desktop/electron/ssh-connection.ts` | `bde4d38d26dd1688b822189a118f69ad07a7ed8b3e058705b2f422ca40a4f304` |
| `apps/desktop/electron/connection-registry.ts` | `1fd7ac3446a0fecb0e31189fe324eb8d8f0da376808c1a3749e757eeaec6f1cc` |
| `apps/desktop/src/plugins/hermes-bots/data.ts` | `b7397b45aa93b3f3c3383f20d7533b712c333582c476049fd76f2645f70ea9b8` |

## Implemented boundary

- `src/idea-lab/v1/hermes-021-enrolled-connection.ts` freezes the corrected source assessment and exact source pins.
- A node-signed enrollment binds tenant, node, connection, exact Hermes runtime, opaque connector route, profile
  identity, and—when SSH is used—the owner-verified host-key fingerprint.
- SSH requires public-key-only batch operation and fail-closed host-key changes. The gateway remains connector-private
  and loopback-bound.
- Control Room receives no hostname, username, port, key path, session value, protected value, profile path, native
  locator, or generic shell.
- The exact operation set is the already-reviewed Hermes lifecycle plus event replay. Arbitrary remote commands are
  forbidden.
- A safe multi-machine roster rejects duplicate connection IDs, routes, profiles, expired enrollments, and cross-tenant
  entries.
- Signed enrollment makes a route eligible for the later disposable qualification only. It cannot claim native
  qualification, open a live panel, contact a provider, grant approval, or grant command/lease/execution authority.
- The Idea Lab page now states the connection design and remaining enrollment gate without pretending a live connection
  exists.

## Verification

The focused hostile suite covers exact source semantics, signed SSH and local-loopback enrollments, host-key/route/profile
substitution, wrong signer, expiry, unsafe shell/context claims, duplicate and stale roster entries, re-digested authority,
hostile Proxy input, UI truth, and absence of process/filesystem/network/provider clients. The focused IDEA-109B/UI
tests pass 10/10 and the complete CR12B suite passes 110/110. No SSH connection, native
Hermes call, provider call, protected-value access, or repository-external write occurred.

## Remaining gates

IDEA-110 still needs one exact signed node enrollment, a repository-owned native port, a refreshed owner packet and new
owner authorization, one attended disposable qualification, independent review, and architect acceptance. The earlier
IDEA-109/109A upstream-method proposal remains historical optional hardening and is no longer on the critical path.
