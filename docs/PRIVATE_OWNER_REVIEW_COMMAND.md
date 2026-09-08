# Private owner-attended task review command

This command provides a first owner-facing surface for the existing review session.
It is not a new login system, browser signer, key vault, deployment authorization or
continuous approval service. No real signing setup or native attempt is qualified by
its synthetic tests. The normal website still accepts separately signed packets.

After separately reviewed and authorized owner setup, the owner—not an unattended
agent—may run this from an attached private terminal:

```sh
node scripts/review-private-owner-task.mjs --configuration /absolute/owner-review.mjs
```

`--help` is inert. There is no automatic confirmation flag, environment consent,
stdin-pipe fallback or automatic retry. Never run the command as a daemon. On macOS,
the owner must execute it in their attached Terminal and handle any separately
approved credential-store interaction; agents must not type the confirmation or
approve a Keychain prompt. The command itself does not acquire/unlock a key store.

## What the owner sees and does

The command displays the exact prompt/instructions, project, task, attempt, node,
model/provider, duration/deadline, input/operation digests, dedicated owner-key ID
and fingerprint, and review digest. It also displays the separate recovery operations
(`status` and `stop`) and their expiry. Check all of these before confirming.

Task strings are quoted and control/bidi/non-ASCII characters escaped so untrusted
content cannot clear the terminal, hide a field or impersonate the command's prompt.
Escaped presentation does not change the signed bytes. Full task text is private
project data: use a trusted terminal, disable session recording, and do not paste its
output into GitHub or public logs. Fixed result/error summaries do not print packets,
signatures, private keys or raw diagnostics.

The owner types the displayed `APPROVE` phrase with its exact review digest. Any other
answer declines without signing or storing. This confirmation is bound to that one
review; a separate trusted current-key/pin guard must also pass. Losing the attached
terminal, source freshness, current key or deadline refuses issuance. A TTY check is
an accidental-automation guard, not proof against a malicious same-user process or a
human-attendance attestation. All existing owner-attended restrictions still apply.

After confirmation, the existing issuer attempts exactly two signatures (task approval
and bounded recovery). Only the complete verified packet is passed once to existing
canonical intake. Receipt validation reuses the application's strict schema and checks
exact project/job/attempt/operation/packet bindings, with no standalone execution
authority. The expected packet is captured before delivery to prevent callback mutation
from changing what receipt is accepted. This command never submits work to the queue.

## Operator module

The `.mjs` module must pass the existing Unix protected-file gate: canonical absolute
regular path, no symlinks, current UID ownership, no group/other access, bounded size.
It is trusted executable code, not an uploaded configuration or sandbox. Protect its
directory and dependencies. Windows ACL support is not implemented; do not bypass the
gate. Keep all real identities, locations and credential references out of the repository.

Export `schema = 'control-room.private-owner-review-configuration/v1'` and asynchronous
`createConfiguration({ signal })` returning:

- `target`: exact `projectId`, `jobId`, `inputDigest`;
- `load(target, signal)`: the authenticated canonical-preparation port from
  `NativeOwnerReviewSessionPorts`, including its synchronous current-source fence;
- `signing`: dedicated canonical Ed25519 `publicKeySpki`, `timeoutMs`, `clock`,
  `sign(bytes, signal)`, and synchronous `assertKeyCurrent()`;
- `store(packet, signal)`: one call to existing authenticated canonical approval
  intake, returning its saved receipt; never a dispatch or provider operation;
- `close()`: release all owned resources, including partial acquisition cleanup when
  the factory fails before returning. Cancel/drain owned signing channels appropriately.

`assertKeyCurrent` checks already provisioned separate owner custody/public pins, not
a browser flag, login assertion or online server signing key. It must not itself sign
or unlock credentials. Actual signing happens only after terminal confirmation and
must reuse the accepted bounded channel implementation. `load` must not accept an
agent's unverified preparation as canonical. Parsing a receipt does not authenticate
its sender; `store` must own that existing authenticated connection.

No concrete private module is generated from fixture inputs. Trusted request delivery,
current-source invalidation, selected signer channel, distinct owner-key provisioning,
current pins and actual host setup remain separately required. The evaluated ssh2
package is not automatically installed or promoted into the application by this command.

## Interruption, cleanup and evidence

The command requests cancellation after five minutes, checks elapsed monotonic time
around awaited stages, and handles SIGINT/SIGTERM. The issuer has its existing shorter
signature deadline. Cancellation is cooperative, not preemption of unresponsive trusted
code. Cleanup observation is bounded to 15 seconds; timeout does not prove an external
signature or resource stopped. Final termination/cleanup remains operator-owned.

Exit zero with the stored-packet summary requires a matching canonical receipt and
observed clean resource release. Declining also exits zero, with a distinct no-signing
summary. Any uncertain signature, storage response or cleanup returns nonzero. If
storage committed but its response was lost, inspect the existing canonical readback
for the exact task. Do not re-sign or automatically repeat the command. No durable
local packet recovery or across-process signing deduplication is claimed.

`tests/private-owner-review-command.test.mjs` injects synthetic terminal responses,
synthetic in-process signing and actual disposable canonical storage. It checks inert
help/non-TTY refusal, full review before signing, decline, lost terminal/key approval,
unknown/mismatched stored receipts, terminal-control escaping, storage-callback
mutation, cancellation after commit and cleanup rejection/timeout. The compiled variant
requires the actual `ownerReview.js` exports with no source fallback. None of these
tests proves real owner attendance, actual key custody, live transport or deployment.
