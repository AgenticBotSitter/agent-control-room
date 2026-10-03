# Mac-local soak rehearsal

The soak runs a fresh disposable Mac-local installation in the foreground. It uses
`rehearsal/setup.ts`, the journey's first-owner helpers and signed connector release,
then the production web/intake and fleet-gateway launch functions. It requires a
Mac, PostgreSQL 17 binaries, Python 3 (for process groups), `ps`, `lsof`, dependencies
and a current `pnpm build` from a clean committed checkout (the existing connector
signing helper requires it). Leave this build uncommitted for the lead; run the real
soak after the lead integrates it. It never launches a real bot CLI. The flag
`CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1` is enforced on every child.

Run from this checkout, with no other rehearsal using its shared connector release.
The harness refuses an existing signed connector advertisement and a concurrent soak.
Use a fresh output directory on every run. The default port block is 59820–59823:
database, web, work intake, gateway. The selected ports must be unused.

```sh
pnpm build
CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 pnpm test:soak:short

# Three hours: leak verdict; choose an unused port block and output directory.
CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node --import tsx scripts/mac-local/rehearsal/soak.mjs \
  --minutes 180 --port-base 59830 --output .test-tmp/soak-three-hours

# Twenty-four hours.
CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node --import tsx scripts/mac-local/rehearsal/soak.mjs \
  --minutes 1440 --port-base 59840 --output .test-tmp/soak-day

# PostgreSQL-free owning unit-test lane, also reached by test:components.
CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 pnpm test:soak:analysis
```

`test:soak:short` first runs the analysis/harness lane and then observes the real
stack for ten minutes, excluding setup time. Short mode checks wiring; memory is
NOT judged and its PASS gives no leak verdict. Long mode accepts 10–1440 minutes;
use three hours for the leak verdict. The sandbox build cannot prove
this runtime: DB-VERIFIED: no. A real-PostgreSQL runner must run the short mode before the long mode.

Pools are warmed with twenty owner reads and twenty distributed bot reads before
the observation clock starts, so short-mode trends exclude initial pool allocation.

Three in-process scripted bots use the existing `ScriptedBotV1` and real connector
client/dispatcher. They download the signed bundle, enroll, propose one task, and
claim/replay, report progress, rotate credentials, return results and wait for owner
review. The owner approves tasks, offers them to the fleet, rejects every seventh
proposal and every fifth returned result, and reads the inbox. Pauses vary from two
to six seconds, with fifteen seconds between cycles. Every fifth cycle makes twenty
parallel owner reads; every sixth cycle races two bots for the same offer, requiring
one winner and a conflict refusal for the loser. Sessions renew before writes and after an expired read so
long mode exercises fresh owner authentication.

Every minute (plus initial/final snapshots) `samples.csv` records elapsed time, RSS
and numeric open descriptors for the harness, setup owner, postmaster, web and
gateway; database connection count, per-table table/index bytes and estimated dead
tuples; transient files under the disposable root; attention and truth counts;
request p95 including body reception; completed cycles and invariant counters.
The request buffer is bounded at 4096 measurements per interval, and each request
has a ten-second deadline. Startup has a ten-minute deadline; runtime has the
requested duration plus one minute for final observations. A missed window or sample gap above 75 seconds fails.

Inbox truth is read independently through the existing production fleet-owner
login (no added grants): ordinary proposed/waiting-approval/failed/orphaned tasks
in the soak project, plus unreviewed fleet results. The needs-me task cursor is
fully traversed and combined with pending results from the owner Workers board.
Snapshots retry up to three times when before/after SQL truth changes during gateway reconciliation.
Both identifiers and counts must match; equal counts with different IDs fail.
Additional checkpoints validate truth after proposing and returning a result.
This is scoped to this fresh, ordinary-task workload; it does not validate all
native-artifact or planner attention categories. The Workers board's fifty-result
limit cannot hide pending work: the full SQL pending set must still match.

OLS slopes use elapsed minutes after the first two minutes of warmup, except RSS.
RSS is judged on its lower envelope independently per process. After a twenty-minute
warmup, split elapsed time into complete five-minute buckets: [20, 25), [25, 30),
and so on. Use each bucket's minimum RSS and its actual observation time for the
OLS fit; discard the trailing incomplete bucket. At least twelve complete buckets
are required (at least eighty minutes total). With fewer buckets, including every
ten-minute run, RSS reports "not judged (run too short)" with no RSS PASS or FAIL;
the summary states that memory was NOT judged, and an overall PASS covers only
judged checks without giving a leak verdict. There is no plateau search: continuous
growth is judged like any other curve once twelve buckets exist.
RSS fails only when the envelope slope exceeds the limit AND the last bucket's
minimum exceeds the first bucket's minimum by more than the limit times the elapsed
time between those two minimum observations. Otherwise it passes. This compares
bucket minima rather than a GC trough with a final peak. `analysis.json` records the
minimum [elapsed minute, RSS bytes] pairs as `bucketMinima` for each process.
Default limits are conservative alarms rather than proof of bounded growth:

| Measurement | Maximum slope | Reason |
| --- | ---: | --- |
| Per-process RSS (also the summed PostgreSQL children) | 256 KiB/min | Allows allocator/GC noise; sustained growth would add 120 MiB in eight hours. |
| Per-process descriptors | 0.1/min | Allows roughly one descriptor per ten minutes; long mode catches small steady leaks. |
| DB connections | 0.05/min | Pools should stabilize; allows one connection per twenty minutes. |
| Transient files | 0.1/min | Temporary and lock files should be reclaimed between cycles. |
| Estimated dead tuples | 20/min | Allows autovacuum sawtooth; sustained growth above this needs investigation. |
| Table and index bytes, independently | 64 KiB/min beyond workload allowance | Persistent task/audit/history rows are expected to grow. |

Each cycle receives a 256 KiB allowance for table growth and another 256 KiB for
indexes before fitting residual storage slopes. The scripted payloads are tiny;
this allowance covers multiple audit, batch, claim, progress, credential and review
rows and page allocation. CSV preserves raw sizes for calibration on the first real
run. The allowance can hide a smaller per-cycle storage leak; it is stated explicitly
and should be tightened with production evidence. Numerical threshold comparisons
use a relative 1e-9 tolerance for floating-point fitting.

The harness tags an interval at the source before firing its measured owner-read
burst, and persists that boolean as `burst_interval` in the stack CSV row. Checkpoint
observations preserve the tag until a recorded interval resets it. Burst intervals
are excluded from latency decay. The p95 of the first three post-warmup non-burst
interval p95s is the baseline; the p95 of the last three is the tail. At least six
non-burst intervals are required. Tail above twice baseline fails, and a zero/missing
baseline or missing burst tag fails. Burst interval count, median p95 and maximum
p95 are reported separately as information in `summary.txt` and `analysis.json`.
Legacy CSVs without `burst_interval` are refused; replay must derive burst membership
from the recorded cycle counter crossing multiples of five, or repeat the run.
This does not establish a fixed latency SLO. Missing/nonfinite/reordered
samples, changed process PID, process exit, duplicate task claims, work running
more than two minutes, any work still running at the end, or any inbox mismatch
also fail. Claim replay must return the same ID. No automatic service restart is
allowed: a dead child fails the run.

`summary.txt` is written early and updated after every observation. At completion it
contains a plain-language pass/fail with reasons; `analysis.json` records fitted
slopes/limits. Outputs never contain credentials, bot answers, machine usernames or
home paths. Private disposable credential/config files are necessary for rehearsal
startup and are removed with the disposable directory on successful cleanup.

All helper children stay attached with stdin pipes, and each helper is put in its
own process group with `setpgid`, without detaching or changing sessions. The owned
setup mode launches `postgres` directly in the foreground, instead of `pg_ctl start`.
The web/gateway wrapper closes the existing services when its stdin ends, on Ctrl-C
or SIGTERM. Normal/error/timeout paths close measurement connections, close child
pipes, wait for shutdown, then clear only the groups the harness started and verify
that they are gone. Setup uses the existing cluster teardown ladder. Failed cleanup
fails the run and preserves scratch/lock material for diagnosis. SIGKILL cannot run
a parent's finally, but the helper stdin pipes close; uncatchable system failure is
outside the guarantees of a JavaScript harness. Never use this against live data.
