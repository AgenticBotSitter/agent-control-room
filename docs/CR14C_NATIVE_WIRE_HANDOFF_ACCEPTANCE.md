# Native wire handoff — local acceptance

## Delivered

Production `cd2fc0a` adds a shared bounded packet codec and optional node
`openWire`/`receiveWire` plus server `attachWire`, mounted in coordinator startup.
An unchanged signed raw frame travels with canonical base64 saved result bytes exactly
when its completed snapshot claims a result. The node reads those bytes inside its
existing ordered send operation; the server decodes into its existing authenticated
managed input. No fixture must choose an application operation or supply result bytes.
See `CR14C_NATIVE_WIRE_HANDOFF_CONTRACT.md` for limits and ownership.

Independent static production review accepted `cd2fc0a` against `d89fb70` with no
actionable findings. Separate test review accepted the opaque journey/helper at
`5bc08ff` and the final denial correction at `08bebff`. Reviewers did not execute these
tests; the following results were executed centrally. The delegation-review workflow
kept worker authorship, independent review and root integration separate.

## Actual evidence

- Stage zero: exit0, ready_for_runtime_check; no setup or native qualification.
- Five real disposable-journal/fake-provider journeys passed: explicit-only start,
  exact result into pending review, lost completed packet over same-runtime reconnect,
  lost ACK over runtime replacement with exact canonical replay, and missing/tampered
  bytes rejected without evidence/result/protocol/ACK writes. The five entries group
  initial, two reconnect and two negative scenarios.
- Eighteen denial entries passed, covering canonical base64, immutable raw preservation,
  returned byte copies, frame/result/outer limits, direction, missing/extra result bytes,
  invalid UTF-8/JSON/version, real wire handshake, transport reuse and exact-once close.
- Final combined run at `08bebff`:72 passed, zero failed/cancelled/skipped. It includes
  both new suites, all three node-runtime suites, managed startup/input/attempt fencing,
  compiled managed sessions, adapter isolation and test-lifecycle inventory.
- Existing runtime/session/startup regressions passed39 and18 in earlier runs. The
  private application rebuilt successfully; compiled managed sessions passed3. TypeScript
  and full ESLint passed again after the final test correction. Both new suites are
  registered in the normal package lifecycle.
- No schema change. The full2,735-pass/two-skip lifecycle record applies to predecessor
  `decd685`, not this new implementation; see `CR14C_NODE_RUNTIME_LOCAL_LIFECYCLE.md`.
  This block has scoped regression evidence, not a new full lifecycle or Linux CI pass.

## Review corrections and preparation limits

The first18-entry denial run passed, but independent review identified two weak
assertions: oversized whitespace was also invalid JSON, and closure after malformed
input could falsely pass if reuse refusal had already closed a transport. The author
corrected both in `c8dd5c2`, integrated as `08bebff`: an otherwise-valid packet passes at
262,144 bytes and fails at262,145; both close counters remain zero after reuse refusal.
The65,537-byte reader case now explicitly acknowledges simultaneous size/hash mismatch
against its signed65,536-byte claim rather than claiming isolated cap proof. Final
combined evidence includes all corrections. Production required no review correction.

Both workers used isolated source-only worktrees. Stage zero reported setup_required,
exit2, missingtsx/zod; no dependencies were installed or linked. Protected Git metadata
prevented their single commit attempts. They stopped; root inspected the exact allowed
files and committed/integrated them through approved local Git operations. No source-only
setup result was promoted to runtime evidence. No GitHub calls were made in this block.

## Limits and next coherent block

Supplied packet ports are not physical HTTPS, a configured host, a live result transfer,
or production authentication evidence. Existing signatures, owner approval, local
ceilings, journals and canonical task checks remain authoritative. No new task starts
from receipt, framing or reconnect. Missing result bytes cannot be silently ACKed.

Next: explicit native-wire HTTPS host composition and startup mounting. Join outbound
node connection ownership to the private server packet ingress using the accepted wire
ports. Own bounded HTTP packet collection, ordered delivery, connection replacement,
cancellation and shutdown through supplied network ports; test the whole mounted
initial/result/reconnect path rather than another unmounted codec. Preserve machine
identity separately from browser Access sessions, and do not widen the human HTTP
adapter's limits. Root chooses exchange mechanics without cyclic send/reply waits.

Continue on Astra Medium for local implementation; use independent boundary review.
No network call, listener, credential read, installation, service start, deployment,
owner-signing custody or PR #329 activation follows. GitHub publication/CI remain paused
by explicit owner instruction, not passed or waived.
