# Proposed E02: disposable real-PostgreSQL candidate comparison

Status: owner approved and executed on 2026-09-06. See [E02 results](REUSE_E02_POSTGRES_RESULTS.md).
The single cluster was stopped and removed within the original window; this packet is
historical authority, not permission to start another cluster. The proposed scope below
is retained so results can be compared with what was authorized.

## Proposed scope

One disposable local cluster on this Mac, at most 20 minutes from first server start, including controlled stop/restart tests. Synthetic jobs only. No production credentials, providers, native Hermes/Codex calls, app activation, VPS changes, elevated OS user creation, system-wide installation, autostart or persistent service registration.

Use a fresh `mktemp -d` evaluation root recorded in the download ledger before acquisition. Keep binaries, data, socket directory, logs and test artifacts under that root. Check available storage first; reconsider if below 20 GiB or acquisition/evaluation exceeds 1 GiB. Acquisition authorization does not waive source/integrity checks.

Prefer unpacked PostgreSQL binaries over installing Docker, a global Homebrew service or a desktop application. [Official macOS download guidance](https://www.postgresql.org/download/macosx/) includes a binary-archive route. An alternative is the maintained [embedded-postgres distribution](https://github.com/leinelissen/embedded-postgres), which offers platform packages; it is not yet downloaded or cleared. Inspect exact release provenance, license files, executable architecture and dependencies before selecting a binary. Do not silently add Rosetta or a compiler if a chosen package requires them. The wrapper/library itself is optional: use existing `initdb`/`pg_ctl` lifecycle commands rather than inventing a daemon manager.

Start with `listen_addresses=''`, a short private Unix-socket directory and `unix_socket_permissions=0700`; directory also owner-only. PostgreSQL documents that an empty listen-address list disables all IP listeners and permits Unix-domain sockets only. [Connection settings](https://www.postgresql.org/docs/current/runtime-config-connection.html). Use fixture-only authentication, a cleared connection environment and explicit executable/data paths. Verify effective settings and no TCP listener before tests. Do not rely on the default loopback listener.

## Initial common acceptance cases

1. Same-transaction canonical marker/audit + actual pg-boss enqueue, commit/rollback and lost-ack readback; then run the existing canonical fixture against real PG where the fixture can be adapted without rewriting product policy.
2. Two independent database clients compete for synthetic jobs; no duplicate claim among simultaneously active consumers. This is engine concurrency evidence, not yet full project eligibility/capacity policy.
3. Worker interruption, safe retry and failure; unknown external starts remain an explicit synthetic hold, not an assertion of exactly-once provider effects.
4. Stop and restart the owned server/client; committed pending/completed records remain discoverable. Bound every operation; avoid a hung cleanup path.
5. Schema initialization separated from restricted submission/worker roles; private web role cannot access operational jobs. No blanket grants as a test shortcut.
6. Record follow-on gaps for scheduler/DST, review/revision, upgrade/drain and restore separately. Do not declare the complete finalist test card passed from this initial block.

## Deadline and cleanup

Before startup, establish a bounded shutdown path that targets only this cluster by exact data directory/owned process handle. On unexpected startup/connection state, stop the leg rather than trying another host/database. Close test clients, stop this cluster using its own lifecycle tool, verify process/socket absence, and preserve sanitized results plus exact package inventory. Remove only its recorded disposable data when shutdown is confirmed; if uncertain, retain it and report instead of deleting open state. Binaries may be retained with an explicit reason/size in the ledger for a comparative rerun. Never clean global caches or other database directories.

Owner decision received: authorized this one temporary local server evaluation, including its bounded initialization, stop/restart and cleanup. This did not authorize production database provisioning or deployment. The one-cluster evaluation is complete.
