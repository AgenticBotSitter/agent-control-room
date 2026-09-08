# RC9 Kuma full-daemon setup preflight

2026-09-08. **Full-service execution not attempted: scoped native setup and
outbound-update isolation need resolution first.** This is not a failed Kuma
candidate or another passing extracted-helper test. No application modification,
daemon, database, notification receiver, provider or native installer was run.

## Source identity and acquisitions

Reused the earlier comparison pin
`louislam/uptime-kuma@e4821321e559c887b14e37d9979e604b221a8945`; package identity
2.5.3, Node requirement >=20.4.0, MIT root. This is the previous immutable source
pin, not independently established current stable release qualification.
Read `f8-operations.md` and `f8-http-fit.md`, including the corrected actual UP
classification, eleven synthetic HTTP cases, and explicit full-daemon omissions.
None of those eleven cases was repeated or counted as daemon evidence.

Nine bounded exact-pin files were retrieved: package/lock/LICENSE, server.js,
database.js, uptime-kuma-server.js, check-version.js, config.js and notification.js.
Exact URLs, statuses, lengths and SHA256 hashes are retained in
`f8-kuma-daemon-acquisitions.json`. A separate exact registry metadata read for
@louislam/sqlite3@15.1.6 identifies its install behavior; no tarball or executable
was acquired. Initial web reads returned cache-miss errors, then authorized public
source retrieval succeeded. Sources were not executed.

## Concrete setup gates

### Native SQLite is an explicit installation boundary

`server/database.js:296–303` selects the SQLite dialect and requires
`@louislam/sqlite3`. The lock pins 15.1.6, registry tarball
`https://registry.npmjs.org/@louislam/sqlite3/-/sqlite3-15.1.6.tgz`, integrity
`sha512-cVf7hcMrfywYnycatLvorngTFpL3BSWvEy7/NrEfcTyQX8xxj9fdeD553oCTv5fIAk85fluo6mzPq89V3YzrVA==`.
Registry metadata declares:

```
install: node-pre-gyp install --fallback-to-build
module: node_sqlite3
module_path: ./lib/binding/napi-v{napi_build_version}-{platform}-{arch}
host: https://github.com/louislam/node-sqlite3/releases/download/
napi_versions: [6]
```

The install may download a native binary or fall back to compilation. It must not
be enabled wholesale under the current scripts-disabled/no-native-compilation
scope. This preflight has not inventoried tarball contents or proven availability
of a checksum-verifiable Darwin/arm64 prebuilt asset, and does not claim that all
scripts-disabled installations are necessarily unusable. Those precise questions
are the next scoped setup review, before attempting a full dependency installation.
The lock also flags install scripts for other packages; not all are mandatory
runtime/native effects (some are development or optional dependencies). Do not
generalize this flag into a requirement to run every script.

Actual alternatives in database.js are MariaDB and embedded MariaDB (338–414), not
the Control Room PostgreSQL primary. MariaDB configuration creates a database if
absent; embedded MariaDB starts its own server. Switching to either merely to
avoid native SQLite would introduce separate unreviewed effects and is not an
authorized workaround. Kuma observational persistence need not become Control
Room's authoritative task database.

### Update traffic must be disabled before listen, not after

`server/server.js:1771–1779` starts monitors/background jobs after listen, then
unconditionally invokes `checkVersion.startInterval()`. In `check-version.js`,
the function immediately calls its asynchronous checker and schedules a 48-hour
interval. The checker skips only when persisted `setting("checkUpdate") === false`;
otherwise it requests `https://uptime.kuma.pet/version`. No environment off-switch
appears in this inspected path. A blank fresh database is therefore not proof of
outbound isolation, and an after-start UI setting could lose the race.

Before execution, demonstrate a supported offline database initialization/migration
path that sets checkUpdate false before the daemon listens, or another supported
upstream offline mechanism. Do not monkeypatch Axios/checker methods or replace
the daemon with extracted code and describe it as full-service behavior. The
entire daemon/transitive notification, telemetry and update startup closure has
not been audited; absence of another outbound path is not claimed.

### Owned configuration is possible but not sufficient alone

`config.js` exposes explicit UPTIME_KUMA_HOST/PORT (defaults otherwise may bind
all interfaces). `database.js:137–139` supports owned DATA_DIR and local kuma.db;
db-config.json is read from that data root. A sterile cwd is necessary because
server.js:15 loads dotenv from its environment/cwd. No existing owner config,
credentials, accounts, current listeners or database would be used.

`uptime-kuma-server.js:102–109` requires actual dist/index.html in normal mode and
exits if absent. Development exempts that file but changes the execution profile;
it must not silently be substituted for a complete packaged daemon. Package setup
also runs git checkout, normal npm ci and download-dist. That whole setup command
was not run: exact dist provenance and downloader effects remain to inspect.

## Required actual next experiment, after setup review

Use the unchanged full daemon with an owned SQLite database, pinned complete
runtime/dist closure, explicit loopback host/port, verified offline settings and
only a synthetic local notification receiver. Exercise the actual scheduler,
HTTP/JSON monitor, notification provider and stored heartbeat/notification state;
stop/restart the daemon and inspect persistent recovery and duplicate behavior.
Measure a named workload, startup and RSS with bounded process/request lifetimes.
Do not infer notification dedup from equal CR observation digests.

The private probe must be **synthetic** for this experiment. Root's current-source
inspection found no actual private /health or /ready JSON route. Internal
private-serving/private-node-handler readiness and admission503 are not an
existing JSON endpoint. A later small protected readiness projection must preserve
Access/authority; no bypass route is added here. Kuma still offers the stronger
reuse alternative for scheduler/history/alerting, rather than implementing those
engines ourselves. This setup gate does not reject that alternative.

## Resource and cleanup record

Disk before source retrieval: 145,485,484 KiB free (>20 GiB). Owned source root
`/private/tmp/cr-f8-kuma-daemon.xAuK66` measured 892 KiB, far below the 500 MiB
cohort allowance. Source calls used 15-second deadlines and 2 MiB per-file caps;
registry metadata used a 100,000-byte cap. Full dependency unpack/install resource
size is **not measured** and must be checked before invoking a package manager.
No heavy work or process handles were started. Root MIT and registry metadata are
not complete dependency license/advisory clearance. Exact cleanup is recorded in
the acquisition receipt after retaining hashes; no source is shipped as product.

## Follow-up: exact prebuilt and existing offline seams

Additional source/release metadata reads were memory-only and are hash-recorded
in `f8-kuma-daemon-followup-acquisitions.json`; no second retained root or binary
download. Repeated narrowing reads are listed, not hidden as unique acquisitions.

**SQLite prebuilt candidate:** official release v15.1.6 lists
`napi-v6-darwin-arm64-unknown.tar.gz`, 903,679 bytes, at
<https://github.com/louislam/node-sqlite3/releases/download/v15.1.6/napi-v6-darwin-arm64-unknown.tar.gz>.
The current Node runtime reports v22.22.3/darwin/arm64, N-API10 and NODE_MODULE_VERSION127.
This artifact targets N-API6, not a Node127-specific addon build. N-API version
compatibility is plausible but no loading/ABI execution has been attempted.
The release asset's API digest is **null**, and its nine listed assets contain
only platform tarballs, no checksum/signature file. Release notes contain only a
changelog link. No independent binary checksum/signature was located in these
inspected metadata sources. The npm tarball integrity above authenticates that
package download, not this separately downloaded native release asset. Recording
a first-download local hash would pin the observation but not independently
authenticate an upstream checksum. Root must explicitly resolve that provenance
standard before manual extraction/loading; do not invoke fallback compilation.

**Dist:** upstream extra/download-dist.js derives
<https://github.com/louislam/uptime-kuma/releases/download/2.5.3/dist.tar.gz>, follows
302 redirects recursively, and streams tar extraction into cwd, renaming/deleting
dist backups. Its source has no checksum/deadline/size/path-validation checks.
Do not run that installer unchanged. Official release metadata lists 7,299,676
bytes and digest `sha256:6af8ea6cb9fc9486860eb4916337205d72caeebe1fa5a0f1ce9d4ae06474baa1`.
However its release target_commitish is
`1f0755fb044fe08e99fccde6722062fb2bf6c8f4`, distinct from the earlier screening pin.
That metadata field is not a peeled tag proof. Before combining source and dist,
resolve actual release source and either compare its selected backend changes or
build matching UI inputs. Do not silently combine master-at-2.5.3 and release UI
as an exact-source package. No dist or build-tool dependencies were downloaded.

**Existing offline initialization, not a new migration engine:** database.js has
`Database.initDataDir(args)`, `writeDBConfig({type:"sqlite"})`, `connect()` and
`patch(port,hostname)`. The ordinary server uses connect/patch before listening.
Patch invokes actual legacy SQLite and Knex migrations, then aggregate migration.
`migrateAggregateTable` starts its migration-status listener only if `port` is
truthy (849–883); calling the existing patch entrypoint without a port avoids this
particular listener without skipping migration. Do not set its special migration
skip environment variable as a shortcut.

`Settings.set("checkUpdate", false, "general")` uses the actual ORM to JSON-encode
false into setting.value and invalidates cache (settings.js:71–82); `Settings.get`
parses the stored JSON (28–61). This provides an existing concrete pre-start
settings seam after the schema is initialized. A reviewed offline harness could
use these unchanged methods, verify persisted false, close the database and clear
the settings cache timer before starting the actual daemon. This is source-fit,
not a documented stable public CLI or executed guarantee: importing their closure
and all migrations still requires effect review/native setup. `Settings.get`
starts a periodic cache-cleaner timer, which must not leak from preparation.
The upstream test/prepare-test-server.js only recursively removes data/test; it
is not an offline bootstrap to reuse.

Thus there is a viable candidate setup path without altering Kuma code. Remaining
decisions are exact release pairing, acceptable native binary provenance and
reviewed full dependency/startup closure under the 500 MiB allowance. Full daemon
execution remains pending, not rejected, and no full monitoring acceptance follows.
