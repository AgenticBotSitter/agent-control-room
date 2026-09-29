# Attack-test kit

Shared harnesses for the failure modes that unit tests miss: a pool that
deadlocks, a read that is not a snapshot, a grant that is one privilege too
wide, a function whose `search_path` an attacker can shadow, and a second
owner or a second session.

Everything here is a **test helper**. Nothing in this directory is imported by
application code, and nothing here is reachable from a runtime entry point.

```ts
import { withRealPostgres, roleCannot, roleCan } from "./support/attack-kit/index.ts";
```

## Why it exists

Reviews kept rejecting pull requests for the same four things, each of which a
hand-rolled or skipped harness misses:

- **Guards with no test that catches them.** `assertGuardBites` performs the
  mutation experiment mechanically, so "this guard is covered" is evidence
  rather than a claim.
- **Bugs that only appear on real PostgreSQL.** Pool deadlock, cap-before-filter,
  `search_path` and `pg_temp`, and role grants are all in-process fakes away.
- **Concurrency.** `exhaustPool` and `concurrentWriters` bound wall-clock time
  instead of retrying, so a hang is a named failure and not a slow pass.
- **Second-owner and second-session cases.** `twoOwners`, `twoTenants` and
  `twoSessions` produce independent identities, and `expectNoLeak` asserts that
  one identity's data never appears in another's response.

## `withRealPostgres(body, options)`

Starts a **disposable, socket-only** PostgreSQL 17 cluster, applies the real
migration ledger and the real role files with the production roles, runs
`body`, and then stops the postmaster and deletes the data directory.

```ts
const { value, appliedMigrations } = await withRealPostgres(async pg => {
  await roleCan(pg, "web", "SELECT count(*) FROM tenants");
  await roleCannot(pg, "web", "DELETE FROM tenants WHERE true");
  return service.read(ownerA, projectA, {}, 50);
}, { port: 56170, allowedPorts: [56170], database: "my_fixture" });
```

Properties worth knowing:

| Property | Why it matters |
| --- | --- |
| `port` is required | The kit never picks a port for you. A test that cannot say which port it wants is a test that can hit the live one. |
| `allowedPorts` is enforced | Any port outside the block is refused before `initdb`, so a typo cannot reach port 3210 or 5432. |
| Socket-only (`-h ''`) | No TCP listener is published at all. The cluster is reachable only through its run directory. |
| `appliedMigrations` | A zero would mean a silent no-op, so setup throws instead of handing back an empty schema. |
| Teardown is unconditional | The stop-and-remove path runs in a `finally` after the body's own, so a thrown error, a rejected promise and a body that exceeds `boundMs` all reach it. |
| Occupied ports are refused | A foreign cluster on the port is detected (live `postmaster.pid`, or a published socket) and the runner refuses rather than reusing it. |

### Skipping honestly

`requiresRealPostgres()` is the question a CI lane with PostgreSQL installed
must be able to answer "yes" to. The difficulty is that a bare skip object is
indistinguishable whether or not PostgreSQL is present, so a predicate alone
cannot catch a broken lane — you need accounting. The kit's own test file shows
the working shape: a counter of tests that *must* run, a counter of bodies that
*did* run, and one closing assertion.

```ts
const PG = requiresRealPostgres();
const message = realPostgresSkipMessage();

let required = 0;
let ran = 0;

// May-skip: a lane with no PostgreSQL install step.
const maySkip = () => (PG ? undefined : { skip: message });

// Must-run: a lane that promises PostgreSQL. Records the obligation.
const mustRun = () => {
  if (!PG) return { skip: message };
  required += 1;
  return undefined;
};

// Each must-run body records that it actually executed.
test("the web role cannot create a temp table", mustRun(), async () => {
  ran += 1;
  await withRealPostgres(async pg => { /* ... */ });
});

// The closing assertion, which is what actually bites.
test("this lane ran the real-PostgreSQL tests", () => {
  if (!PG) {
    assert.equal(required, 0, "a lane without PostgreSQL registers nothing to run");
    return;
  }
  assert.ok(required > 0, "at least one real-cluster test is registered");
  assert.equal(ran, required, "a required-but-skipped cluster test must fail the run");
});
```

`realPostgresSkipMessage()` names every directory that was tried, so a skip
tells you whether PostgreSQL is missing or merely in the wrong place. The
distinction between may-skip and must-run is a property of the **lane**, not of
the helper: use `maySkip` where there is no PG install step, and the counter
above where a missing PG must fail the run.

### Cleanup is observed, not assumed

`withRealPostgres` returns `cleanedUp: true` and `leftovers: []`, but both are
computed **after** teardown from the postmaster's real state and the filesystem
— not asserted as literals. If anything survives, the call throws
`attack_kit_cluster_leaked:<port>:<evidence>` naming exactly what did, with the
body's own error attached as `cause` when both failed. Clusters are also torn
down on `SIGINT`/`SIGTERM` (exiting 130/143), because a leaked postmaster holds
a SysV segment that can block every other job.

### The teardown ladder, and why it is ordered that way

A postmaster creates one 56-byte SysV shared-memory segment and releases it on
any shutdown that runs its exit path. **`SIGKILL` cannot run an exit path**, so a
killed postmaster leaves the segment behind with a dead creator and `nattch 0`.
Measured against PostgreSQL 17.11 with `ipcs -m` snapshots around each shape:

| teardown | segment released? |
| --- | --- |
| `pg_ctl -m fast stop` | yes (3/3) |
| `SIGQUIT`, idle | yes, in ~4 ms (3/3) |
| `SIGQUIT` with a prepared transaction pending | yes (1/1) |
| **`SIGKILL`** | **no (6/6)** |
| **`SIGKILL` during startup** | **no (6/6)** |
| `shared_memory_type=mmap` + `SIGKILL` | **no (5/5)** |

`shared_memory_type=mmap` is *not* the fix, despite being PostgreSQL's answer to
this class of leak: that GUC governs the `shared_buffers` region, and the 56-byte
segment is created unconditionally beside it, so it leaks on every `SIGKILL`
regardless. It was measured rather than assumed, and it does not work.

So the ladder is ordered by **what releases the segment**, not by what ends the
process soonest: `pg_ctl -m fast`, then `pg_ctl -m immediate`, then `SIGQUIT`
with a 30 s grace, and only then `SIGKILL`. Reaching `SIGKILL` is recorded in
`failures` as `postmaster_required_sigkill_which_leaks_its_shared_memory_segment`,
so a forced teardown is reported as a forced teardown rather than as a clean
one. The same ladder is in the reaper (`reapKitClusters`), which is the last line
of defence for a cluster whose test command was killed.

To account for a whole run:

```ts
import { sharedMemorySegments, newSharedMemorySegments } from "./support/attack-kit/index.ts";

const before = await sharedMemorySegments();   // null when `ipcs` is unreadable
// ... run everything that starts a cluster ...
const leaked = newSharedMemorySegments(before!, await sharedMemorySegments());
assert.deepEqual(leaked, [], "a cluster was killed rather than stopped");
```

Both helpers return `null` rather than an empty list when `ipcs` cannot be read,
so a guard that could not run refuses instead of reporting a clean result it
never measured. `tests/attack-kit.test.ts` asserts this over the whole suite,
comparing by segment id rather than by count — a teardown that released one
cluster's segment while leaking another's would otherwise show a flat count.

## Concurrency

```ts
// Pool size + 1 concurrent operations must all finish. A handler that holds a
// connection while asking for a second one never finishes, and that is the bug.
await exhaustPool(pool, 8, index => handler(index), { boundMs: 10_000 });

// Interleave appends and reads; every read error is collected and reported.
const { writes, reads, readErrors } = await concurrentWriters(append, read, {
  durationMs: 2_000, writers: 2, readers: 2,
});
```

`exhaustPool` also checks that `pool.options.max` matches the size you claim,
so a test cannot pass against a pool that was silently configured larger.
`concurrentWriters` throws `ConcurrentReadRaceError` with every failure
collected; pass `allowReadErrors: true` to record the count instead.

### A timeout failure reports at least the bound it enforced

`ConcurrencyTimeoutError.elapsedMs >= error.boundMs` is a **guarantee**, not a
rounding accident. A caller that reads `elapsedMs` is being told "the work was
still running when the bound had passed", and a figure smaller than the bound
would be reporting a measurement that was never made.

Two things can make a raw reading land under the bound, and both were measured
on this machine rather than assumed:

- **libuv can dispatch a timer early.** The loop clock is integer milliseconds,
  so a `setTimeout(200)` fires a fraction of a millisecond before the
  sub-millisecond instant it was asked for — 1 in 500 runs, by 0.386 ms.
- **`Date.now()` is quantised and not monotonic.** It is integer milliseconds,
  so a ~200 ms window carries up to 1 ms of error in either direction (measured
  -0.956 ms to +0.952 ms), and an NTP step can move it backwards mid-bound.

So the helpers measure with `performance.now()` (monotonic and fractional) and
report `Math.max(Math.round(measured), bound)`, with a finite guard in front so a
non-finite reading cannot slip through as a number. `elapsedAtLeastBound` on the
error says whether the figure is a real measurement or the bound itself. It is
diagnostic only: the bound was still enforced, and the flag is not a reason to
retry or re-measure. None of this masks a slow timer — a genuine early dispatch
is a fraction of a millisecond, while a real overrun still reports its real,
larger elapsed time.

### Testing the bound without waiting for the timer to misbehave

An early dispatch happens in well under 1% of runs, so a test that runs the real
timer thousands of times still cannot make it deterministic — and a test that
*does* see it is a test waiting for the machine to be unlucky, which is this bug
one level up. `concurrently` and `exhaustPool` therefore take an optional
`now` seam for the deadline's clock:

```ts
// Fires "early" at 199.4 ms for a 200 ms bound, every run.
await assert.rejects(
  concurrently(1, () => new Promise(() => {}), { boundMs: 200, now: earlyClock }),
  /elapsed_200ms/,
);
```

It defaults to the real monotonic clock, so a caller never passes it. It exists
because without it, dropping the clamp at a call site survives every real-timer
test in the file — which is exactly how it was caught during this fix.

**Do not unref a deadline timer here.** It looks like a free optimisation and it
silently disables the detector. An unref'd timer does not keep the event loop
alive, and a deadlocked pool is exactly the state where the loop has no work —
so Node exits with `unsettled top-level await` (code 13) instead of the
`pool_exhaustion_deadlock` failure, and the deadlock goes unreported. The kit's
timers are ref'd and cleared in a `finally`, so a successful run still exits
immediately. If you add a bound of your own, keep the timer ref'd.

## Identities and leaks

```ts
const { ownerA, ownerB, ownerAScope, ownerBScope } = twoOwners();
const { tenantA, tenantB, identityA, identityB, secretForTenantA } = twoTenants();

expectNoLeak(responseFromA, { rows: await readAsB() });

const sessions = twoSessions({ revoke: async (s, at) => setRevoked(s.tokenDigest, at) });
await sessions.revokeFirst();   // the second session must still work
```

`expectNoLeak` is token-based rather than field-based on purpose: a leak that
renames a column or nests one level deeper is still a leak, and a field-by-field
allow-list would need updating every time a response shape changed. It refuses
trivial data, so it cannot pass vacuously.

## `assertGuardBites`

Applies a mutation to a source file, requires the named test command to **fail**,
and restores the file — including when the command crashes or the guard does not
bite.

```ts
await assertGuardBites({
  file: "src/web/v1/access-verifier.ts",
  find: "maxSessionSeconds: 7 * 24 * 3600",
  replace: "maxSessionSeconds: 365 * 24 * 3600",
  testCmd: ["pnpm", "exec", "node", "--import", "tsx", "--test", "tests/access.test.ts"],
  because: "a widened session bound must be rejected",
});
```

- **It refuses to run on a dirty tree** (`DirtyTreeError`). A mutation applied on
  top of unrelated uncommitted work cannot be restored safely.
- The target must occur **exactly once**; an ambiguous or absent target is an
  error rather than a guess.
- A clean exit raises `GuardDidNotBiteError`. A spawn failure (ENOENT, bad cwd)
  is reported separately, because a command that never ran proves nothing.
- Pass an argv **array** rather than a string; the string form is tokenized with
  quote handling, but an array cannot be misread.
- Restoration runs in a `finally` and retries once, so a transient write failure
  cannot leave a live mutation in a working tree.
- The restore is **verified**: the file is re-read and its digest compared with
  the original, so a silently-failed restore raises rather than being assumed.
  This also catches a test command that clobbers the file it was mutating.
- If your `testCmd` spawns another `node --test` process from inside a test,
  scrub `NODE_TEST_CONTEXT` from its environment. An inherited value makes node
  run the child file **inline as a plain script** — no runner, no exit code, and
  its failures never propagate, so every such command would look like a clean
  exit and report that the guard did not bite.

## Grants

```ts
await roleCan(pg, "web", "SELECT count(*) FROM tenants");
await roleCannot(pg, "web", "CREATE TEMP TABLE probe (id int)");   // TEMPORARY on the database
await roleCannot(pg, "app", "CREATE TABLE rogue (id int)");
```

`roleCan` / `roleCannot` **execute** the statement as the role and read the
server's own verdict, rather than consulting `has_table_privilege`. A catalog
lookup can be right while the statement is still refused. `roleCannot` also
checks that the refusal was a privilege refusal (`42501`) and not a missing
table or a typo, so a statement that fails for the wrong reason cannot pass as
proof of a grant. Mutating statements are wrapped in `BEGIN … ROLLBACK`.

## `securityDefinerAuditLive` — the CI GATE

```ts
const { findings, unpinned } = await securityDefinerAuditLive(query, { allowlist });
assert.deepEqual(unpinned, []);
```

Lists every routine whose `prosecdef` is true, or whose `prorettype` is
`trigger` or `event_trigger`, in the app schemas, whose `proconfig` has no
`search_path` element or one whose last element is not the bare identifier
`pg_temp`. A privileged routine with a default `search_path` resolves names with
the **owner's** privileges, so an attacker-influenced schema earlier in the path
can shadow a function the body calls. `pg_temp` must be last: it is searched
first for relations, so a name resolving to a temp object is caught by refusing
to let it sit anywhere else.

**This is the gate, and it is a CATALOG gate.** `scripts/check-migration-search-path.mjs`
runs it in CI over a disposable PostgreSQL 17 cluster built from the real
migration ledger and the real role files, and the attack-kit CI step runs it in
the lane that already installs PostgreSQL 17 — so it costs no second job.

The answer comes from PostgreSQL, not from the migration text: `prosecdef` and
`prorettype` as they are after every statement, and `proconfig` after every
`ALTER FUNCTION … SET/RESET search_path`, across files, with real identifier
parsing. `proconfig` is a `text[]`, one `name=value` per element, and the
`search_path=` value is split as a GUC list — a comma list, double quotes
respected, case-sensitive once quoted. So `SET search_path = 'public, pg_temp'`
(one schema literally named `public, pg_temp`, with `pg_temp` searched first) and
`"PG_TEMP"` (a different schema from `pg_temp`) both fail, as does `pg_temp`
anywhere but last. A `RESET` removes the element entirely, which is how
PostgreSQL records "this routine pins nothing", and a null there is a real answer
rather than a missing measurement.

**Why not read the migrations as text?** Two fix rounds of the text audit each
closed the reported holes and each review found new ones: a cross-file
`ALTER FUNCTION … SECURITY DEFINER`, a later `SET`/`RESET search_path`, a
nested-comment decoy, a quoted identifier. A regex model of PostgreSQL SQL
cannot be made sound, so the text audit was removed from CI entirely. The
catalog is the parser.

The allowlist (`search-path-allowlist.json`) is keyed on a **state**, not on a
name: the routine's **catalog identity** — `schema.name(identity arguments)`
from `pg_get_function_identity_arguments` — **and** the exact effective
`search_path` the entry was written for, with `null` meaning the routine pins
nothing. It also carries an `added` date, an `expires` date within 180 days of
it, and a tracking issue. A new unpinned routine fails immediately. So does an
entry that has expired, an entry that no longer matches any violation, an entry
with an invalid date such as `9999-99-99`, an entry whose `searchPath` is
missing or is not a string-or-null, and an audit that could not classify a
schema it was asked to cover. Known violations in the shipped migrations are
baselined there and tracked by issue 421.

Both halves of the key are load-bearing. Matching on the identity alone meant a
waiver survived a later migration that changed the routine's effective
`search_path` — the routine could be walked onto an attacker-controlled schema
and the gate stayed green, because the entry still named it. Matching on the
recorded value means such a change fails **twice**: the routine counts as an
unpinned violation again, and the entry is reported as
`search_path_allowlist_waiver_no_longer_matches` with the state it recorded. A
waiver is permission to ship a known bad state, and only ever for the state that
was actually reviewed.

## `securityDefinerAudit` — a local HINT, not a gate

```ts
const { findings, unpinned } = await securityDefinerAudit("db/migrations");
assert.deepEqual(unpinned, []);
```

The text-over-migration-files version above. It is kept as a fast local
convenience — it needs no PostgreSQL, so it gives an answer in milliseconds
while you are still writing the migration — and it is **not** wired to any CI
job. Nothing in CI runs it, the gate above does not consult it, and it is not
evidence of anything. If the two disagree, the gate is right and the hint is
wrong. It cannot be made sound: that is the whole reason the gate reads a
catalog.

## What the kit will not do

- **It will not pick a port.** `port` is required and `allowedPorts` is checked.
- **It will not reuse a cluster it did not start.** An occupied port is refused,
  never attached to.
- **It will not read a connection string from the environment.** Every credential
  is a random fixture value generated per run and never printed.
- **It will not touch the live application or a live database.** It only ever
  creates a cluster in its own `mkdtemp` directory.
- **It will not pass silently.** `requiresRealPostgres()` is the check a lane
  with PostgreSQL must satisfy.

## Running the kit's own tests

```
pnpm run test:attack-kit
```

That is wired into the `test-components` CI lane, which installs PostgreSQL 17,
and into the merge-gate catch-up for the same lane. Locally the tests use ports
56170-56179 and every cluster they start is stopped and deleted, including when
a test fails.
