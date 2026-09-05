# Current saved approval revalidation

The internal dispatch preparation method reads the actual saved paired signature packet, not browser
material or a historical receipt. It holds the existing owner/session, project, job, attempt, lease and
node/key checks in the canonical approval transaction, reconstructs current unsigned preparation and
requires the caller's exact expected input and packet digests.

The store verifies row integrity and all saved scope, lease, enrollment, operation and binding digests.
It then runs both owner signatures through the existing pinned-key intake using current server trust.
Expiry, closed pins, absent records, changed enrollment, changed canonical state, mismatched identity,
cancellation or integrity failure refuse output. Both local trust freshness and cancellation remain
checked at transaction commit alongside canonical deadline/owner-session checks.

The returned object is explicitly a revalidated signed snapshot with startsWork and execution-authority
flags false. It contains private enrollment and signed payload for a future internal delivery writer,
so it is deliberately absent from browser operations, HTTP, public lifecycle ports and startup routing.
No deferred freshness callback escapes the canonical transaction. It does not acquire locks across a
network call, queue delivery, issue server signatures or prove authority after transaction completion.
The future writer must perform revalidation and durable queue insertion atomically; it cannot merely
send a snapshot returned by this convenience method later. Node-side current admission and claim/marker
checks are still mandatory before execution. Historical GET receipt behavior remains unchanged.

This block does not widen database privileges or create tables, run providers, use credentials,
open listeners, start services or deploy. Synthetic signatures and disposable SQL prove the integration
only. Owner signing/custody, atomic signed dispatch, node consumption and revisions remain incomplete.
