# Kuma source and packaged UI pairing resolved

2026-09-08. Public source reads only; no daemon, SQLite addon or installer ran.
The Git tag2.5.3 resolves directly to commit
`1f0755fb044fe08e99fccde6722062fb2bf6c8f4`, matching the previously inspected
release dist metadata. Use that exact source with the2.5.3 dist archive/digest
already recorded in `f8-kuma-daemon-preflight.md`. Do not combine it with the
earlier screening commit `e4821321e559c887b14e37d9979e604b221a8945`.

## Actual source comparison

`f8-kuma-release-pairing.json` records exact URL/body hashes for the tag and eight
file pairs. package.json, server.js, uptime-kuma-server.js, check-version.js and
config.js are byte-identical across pins. database.js, notification.js and the
dependency lock differ; the old backend screening cannot be applied wholesale.

`f8-kuma-release-delta.json` preserves the changed package records and source
line-membership differences (not a complete ordering-sensitive diff):

- The inspected database changes move the MariaDB character-set afterCreate
  callback from a general pool block into an explicit database-type guard. This
  matters for SQLite setup; use the release's own code, not a custom repair of
  the earlier screening source. No claim of executed SQLite behavior yet.
- The release notification registry lacks three providers present in the screening
  source: NotifyApp, Signalgrid and AmootSMS. The planned synthetic notification
  provider must be selected from the actual release registry, not assumed from
  the newer-looking source tree.
- Identical package.json does not imply identical transitive code. Exact resolved
  release lock differs across packages including AWS credential-provider families.
  Use the release lock for script-disabled preparation and full dependency review;
  do not mix the two locks or claim that unselected cloud providers were executed.

## Remaining setup and finite experiment

Source/UI pairing is no longer an unknown. Native SQLite addon provenance/load,
bounded full runtime preparation and pre-listen persisted checkUpdate=false
still need actual evidence. Preserve the pinned official release asset's lack of
independent published checksum rather than describing a first-download digest as
upstream authentication. No fallback compilation or whole installer is authorized
by resolving this tag alone. Do not relabel unperformed daemon work as a rejection.

Then execute the unchanged release on an owned loopback/SQLite fixture with an
actual supported local notification provider: monitor transition, notification,
stop/restart, stored settings/history and duplicate behavior. Current synthetic
CR readiness remains a fixture, not a deployed health endpoint. Beszel resource
monitoring is complementary and still independently open.

## Acquisition record

148,198,912,000bytes free before initial source comparison.31 bounded public HTTP
reads across three invocations total4,848,948bytes; sources held in memory only.
The second invocation's verbose delta output truncated before full capture; the
third retained a full receipt and condensed output. No source directory, native
binary or package was retained by these reads. Web-reader API open failed before
the authorized bounded fetch, and supplies no tag evidence. No GitHub writes or
Actions, no new service and no cleanup target. Metadata receipts are retained.
