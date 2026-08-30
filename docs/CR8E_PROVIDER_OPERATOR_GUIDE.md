# CR-8E provider operator guide

**Status:** Effect-free configuration and failure guide. Live use is disabled.
**Applies to:** Bitwarden, 1Password, and destination-native adapters in `control-room-secret-broker/v1`.

## What exists

Control Room can validate provider-private bindings, construct an exact no-shell command plan, accept a strict result from an injected fake runner, pass bytes to one prewired local consumer, and durably record only a safe terminal receipt. It cannot launch a provider CLI or authenticate to an account. The destination-native adapter similarly accepts only an injected fixed resolver; it is not a Keychain, Credential Manager, libsecret, vault, or cloud integration.

The adapter enable flag exists only for effect-free composition tests. It must never be treated as a deployment switch.

## Required private configuration

- Keep the raw Bitwarden item UUID, 1Password `op://` reference, or destination-native locator inside the broker-private adapter configuration. Central records retain only its canonical digest.
- Pin an absolute executable path and its independently established binary digest. The runner must verify the digest immediately before every attempted start.
- Store the SQLite ledger in a non-symlinked owner-only directory and regular owner-only file. Provision its integrity key outside the database and bind a unique ledger-identity digest.
- Provision a rollback-resistant `RollbackCheckpointStoreV1` outside the ledger file, its backups, and its deletion/rollback domain. The repository in-memory implementation is test-only and is not deployment storage.
- Use explicit `create` only during a one-time owner-controlled provisioning ceremony. Every routine start uses `open`; never fall back from a failed open to create. A missing, empty, replaced, older, or wrong-version ledger requires owner recovery and must not be silently regenerated.
- Register only fixed executor, operation, and purpose consumers. Do not expose a general read, resolve, print, shell, prompt, callback, or arbitrary-code consumer.
- Supply a broker-owned clock. Caller time cannot authorize provider use.

## Frozen effect-free command plans

| Provider | Private reference | Planned arguments | Live status |
|---|---|---|---|
| Bitwarden | Exact UUID item ID | `get password <id> --nointeraction` | Disabled |
| 1Password | Exact `op://vault/item/field` reference | `read <reference> --no-newline` | Disabled |
| Destination native | Fixed provider-private locator | No generic command; injected fixed resolver only | Disabled |

The runner contract fixes `shell: false`, `interactive: false`, `inheritEnvironment: false`, `stdin: none`, a 100 ms to 30 second timeout, and a 1 to 65,536 byte output ceiling. Secret material is never an argument or environment variable. The command plans above describe conformance only and are not instructions to run the installed tools.

Bitwarden documents `bw get password` and non-interactive operation, while its authentication model normally depends on CLI login/session state: [Bitwarden CLI](https://bitwarden.com/help/cli/). 1Password documents `op read` and recommends least-privilege service accounts for automation: [1Password secrets in scripts](https://developer.1password.com/docs/cli/secrets-scripts/). Control Room has not accepted a way to supply either provider's authentication without violating the broker's credential-isolation rules. Stop there; do not improvise with an environment variable, command argument, copied session, or worker-readable file.

## Failure handling

| Observation | Required result |
|---|---|
| Exact binding absent or provider proves it did not start/release material | Safe terminal failure |
| Binary digest differs, output exceeds the hard limit, or result shape contains extra/unsafe fields | Wipe captured bytes and record terminal ambiguity |
| Runner disconnects, times out without proof, or reports unknown outcome | Terminal ambiguity; never retry the invocation |
| Consumer throws, returns malformed output, or cleanup is uncertain | Wipe the broker buffer and record terminal ambiguity |
| Broker restarts with a claimed invocation | Convert it to durable terminal ambiguity before accepting work |
| Grant expires or the broker clock moves backward after material use | Terminal ambiguity |
| Catalog entry is replaced or revoked before claim | Deny before provider resolution |
| Ledger key, identity, row set, schema, ownership, or mode check fails | Do not open the broker for service |
| External checkpoint is missing, stale, unavailable, malformed, or conflicts | Fail closed; preserve both states for owner-led recovery and do not recreate the ledger |

A failed or ambiguous invocation is not returned to a ready queue. Create a new policy decision and new invocation only after an operator determines that another attempt is safe. Never rewrite an ambiguous receipt into success or definite failure.

## CR-8E-008 owner gate

Live qualification needs a new owner-approved packet naming the provider, disposable account/item, machine, runner, maximum calls, exact canary, cleanup, and evidence retention. It must prove authentication custody, narrow authenticated IPC, executable identity, process/output bounds, no worker access to credentials, broker-only network access, consumer network denial where required, rotate/revoke behavior, restart behavior, rollback-resistant checkpoint custody, split-commit recovery, and exact cleanup. Until that gate is accepted, no provider adapter is production-eligible.
