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

## `securityDefinerAudit`

```ts
const { findings, unpinned } = await securityDefinerAudit("db/migrations");
assert.deepEqual(unpinned, []);
```

Lists SECURITY DEFINER and trigger functions whose `search_path` is missing or
does not end in `pg_temp`. A privileged function with a default `search_path`
resolves names with the **owner's** privileges, so an attacker-influenced
schema earlier in the path can shadow a function the body calls. `pg_temp` must
be last: it is searched first for relations, so a name resolving to a temp
object is caught by refusing to let it sit anywhere else.

`assertSearchPathPinned(dir)` throws instead of returning, and
`securityDefinerAuditLive(query)` runs the same audit against a live catalog for
bodies a later migration replaced.

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
