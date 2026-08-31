# CR-8E node-local credential reference contract

**Status:** Frozen for effect-free repository implementation through CR-8E-007
**Version:** `control-room-secret-broker/v1`
**Live providers:** Disabled

## Outcome

Control Room may name a logical credential reference, but it cannot retrieve the credential material. Resolution occurs only inside a node-local broker after the existing node policy layer has admitted the exact operation. The broker passes material directly to a trusted node-local consumer and returns only a strict safe receipt.

This boundary is not a general secret vault, a remote credential API, an approval mechanism, or execution authority. Credentials never enter central PostgreSQL, node journals, logs, fixtures, evidence, artifacts, prompts, Telegram, MCP, Git, command arguments, environment variables, or returned errors.

## Safe catalog

A catalog entry contains only:

- logical credential reference, tenant, and exact node;
- sorted project, executor, operation, and purpose allowlists;
- provider kind and a digest of the provider-private locator;
- material class, active/revoked state, monotonic revision, and safe timestamps;
- a maximum lease of 300 seconds and mandatory single-use semantics; and
- a canonical entry digest.

Provider item names, vault paths, account names, field names, values, recovery material, and raw locators are forbidden. Registration is exact-replay safe. Catalog inputs are cloned before storage, nested authority arrays and entries are frozen, and register, replay, replace, resolve, and snapshot return isolated frozen copies rather than internal references. Replacement requires the expected current digest, a one-step revision increase, unchanged tenant/node/creation identity, and non-decreasing rotation time. A replacement may narrow, rotate, or revoke; it grants no node authority by itself.

## Local invocation grant

The grant is derived from one accepted exact `LocalPolicyDecisionV1` and its canonical `NormalizedLocalPolicyRequestV1`. It binds tenant, node, project, job, attempt, executor, operation and operation digest, authority digest, admission request and digest, one catalog revision, one credential reference, one purpose, issue/expiry times, and a nonce digest. The raw nonce is not retained.

The admitted request must already contain the credential reference, and its operation digest is recomputed. Catalog scope is an additional ceiling. The grant lifetime cannot exceed the catalog maximum. A caller-computed grant is only data: the broker must have issued the exact grant through its private local authorization seam before it can be consumed.

## Single-use lifecycle

Before provider resolution the broker atomically records the invocation as claimed. The invocation has one terminal result:

```text
authorized -> claimed -> succeeded
                    |-> failed       (provider proves no material was released, or consumer proves failure)
                    |-> ambiguous    (provider, consumer, or cleanup outcome is uncertain)
```

An exact retry returns an immutable copy of the existing terminal receipt and never reacquires material, including after the original grant expires or its catalog entry is later revoked. Changed data under an invocation ID is a conflict. A simultaneous duplicate sees `in progress` and cannot run a second consumer. Expired grants and revoked or replaced catalog entries fail before first resolution.

Only explicitly typed provider unavailability is a definite failure. A provider exception may have occurred after resolution and is therefore ambiguous. Consumer exceptions, malformed or material-bearing output, and cleanup failures are also ambiguous. Ambiguity is terminal and never automatically resolves the credential again.

## Material handling and cleanup

The provider submits a byte buffer plus a release function to the broker. Provider-controlled binary values are never authenticated through `instanceof` or ordinary `.buffer`, `.byteLength`, iterator, slice, or fill property reads. The host boundary applies captured native `%TypedArray%` and `ArrayBuffer` intrinsics, requires the exact `Uint8Array.prototype`, exact dense indexed view keys, an exact zero-own-key `ArrayBuffer.prototype` backing store, byte offset zero, view byte length equal to the complete backing-store byte length, valid bounds, and no own metadata or behavior. Proxies, `SharedArrayBuffer` views, detached stores, partial or widened backing-store views, subclasses, prototype drift, accessors, data-property or method shadows, symbols, or extra keys fail closed without executing caller behavior.

Every accepted provider value is copied once into a boundary-owned ordinary `Uint8Array` before the next trust layer receives it. The runner adapter, destination-native adapter, and broker each wipe the buffer they accepted through a captured native `fill`; the broker also zeroes its consumer copy in `finally`, then calls provider cleanup. Rejected actual typed-array values are wiped intrinsically when possible, including shared, shadowed, or partial views, by constructing an intrinsic full-buffer view over the actual backing store and zeroing every backing byte without consulting caller properties. JavaScript zeroing cannot prove that a provider, native library, shared-memory peer, or consumer made no copies, so production provider isolation, process lifetime, OS account separation, and provider-native cleanup remain required controls.

Consumer output is a strict success digest, safe definite-failure code, or safe ambiguity code. Consumers submit that result exactly once through a broker-owned synchronous collector and return `Promise<void>`; they do not return an arbitrary result object through Promise resolution. The collector uses Node's host-level non-trapping Proxy detection before accepting the object, preventing JavaScript thenable assimilation from reading `.then` on a Proxy before validation. Missing, duplicate, late, throw-before, throw-after, and Proxy-then-ordinary recovery attempts fail closed. If a provider submitted material before later violating the collector contract, only the broker can recover that first value, and only for immediate wiping and cleanup. Before schema parsing or any other property read, the broker selects the expected result variant from an own data descriptor and snapshots exactly its allowed enumerable string-keyed data fields. Proxy, accessor, inherited, symbol, hidden, non-enumerable, and extra shapes fail closed without executing object behavior. Receipts state `grantsApproval: false` and `grantsExecutionAuthority: false` and carry no material, locator, provider payload, raw error, or free text.

## Deployment boundary

The repository now contains an exact-schema SQLite invocation ledger, fixed-consumer routing, and effect-free Bitwarden, 1Password, and destination-native provider adapters. The SQLite ledger requires a private owner-only directory and file, an external integrity key, an exact ledger-identity digest, and a `RollbackCheckpointStoreV1` outside the ledger file's deletion/rollback domain. First creation and normal open are distinct modes: normal open rejects a missing, empty, uninitialized, or wrong-version file, while recreation under an existing checkpoint conflicts. Every authenticated state transition advances a monotonic revision and compare-and-swap external checkpoint over the complete ledger state and trusted-time high-water. Mutation, row deletion, whole-file deletion/recreation, older valid-file replacement, clock rollback, foreign schema objects, wrong identity, wrong key, or checkpoint drift therefore fail closed. Every claimed invocation found at restart is durably settled as terminal ambiguity before the ledger can be used again.

The included in-memory checkpoint is effect-free test evidence only. A real owner-controlled rollback-resistant checkpoint implementation, one-time provisioning ceremony, upgrade/recovery procedure, and handling for a crash between ledger and checkpoint commits are deployment requirements. Such ambiguity must fail closed and require owner recovery; it cannot silently initialize a new ledger.

The CLI adapters do not execute a process. They create a frozen plan for an injected node-private runner: absolute executable, expected binary digest, exact arguments, no shell, no interaction, no inherited environment, no stdin, hard timeout, and hard output ceiling. Provider, runner, native-resolver, and consumer results all cross broker-owned synchronous collectors rather than arbitrary Promise result values. Runner and native-resolver functions are captured at construction. Result envelopes must be ordinary exact data objects, and nested binary material must satisfy the intrinsic exact-`Uint8Array` boundary above: Proxy, prototype, symbol, hidden, non-enumerable, accessor, extra-field, shared/detached backing, binary metadata shadow, subclass, prototype drift, invalid binary, and size widening fail closed without executing object behavior. Any actual typed-array bytes safely reached during rejection are wiped. Transparent, key-hiding, descriptor-fabricating, and throwing Proxies are rejected with zero traps at the direct broker, fixed-consumer, runner, destination-native, configuration, binding-array, binding, and nested-buffer seams. Private provider locators live only inside adapter bindings. Provider acquisition and fixed-consumer functions are likewise captured at construction. The public invocation seam selects only a prewired executor/operation/purpose consumer and cannot accept caller-supplied credential-handling code.

Bitwarden planning uses an exact UUID item ID and `bw get password <id> --nointeraction`. 1Password planning uses an exact `op://` reference and `op read <reference> --no-newline`. These shapes follow the vendors' documented read commands, but authentication and session transport are deliberately unresolved: [Bitwarden CLI documentation](https://bitwarden.com/help/cli/) describes session/authentication state, and [1Password CLI scripting guidance](https://developer.1password.com/docs/cli/secrets-scripts/) describes service-account and script authentication. The current runner contract forbids inherited credential-bearing environment state, so neither documented authentication path is automatically eligible.

`allowEffectFreeProviderAdapters` is a test/composition switch, not deployment authority. No native runner, provider authentication, credential-store access, CLI launch, network route, IPC listener, or live consumer is implemented. Before a live provider can be enabled, CR-8E-008 must separately prove broker-only authentication custody, authenticated narrow IPC with no generic resolve/read method, executable/path ownership, process and output containment, broker-only egress, consumer egress denial, rotation and revocation, redaction canaries, and owner-attended cleanup. Installation, authentication, account access, vault reads, native prompts, and canaries require new exact owner authority.
