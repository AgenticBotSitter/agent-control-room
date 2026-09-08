# F1 queue/workflow comparison acquisition ledger

2026-09-08. New comparison-goal authority; source baseline 44f9064.
Storage before acquisition: 140 GiB free. Owned root:
`/private/tmp/cr-compare-f1.9x5bSO`. Initial source cohort limit 250 MiB;
global retained evaluation budget 4 GiB, stop acquisition below 20 GiB free.
Planned: pinned DBOS and Hatchet public source archives/metadata, followed by
isolated package evaluation only after source inspection. No lifecycle scripts,
personal credentials, GitHub writes or production dependencies. Heavy service
experiments are serialized by the root agent. This ledger will record actual
acquisitions and cleanup; a planned acquisition is not a completed download.

DBOS main pin: d8c4974cca6cc84b296f3b8edfbbb41627ddd47e (2026-09-04).
Source archive acquired from codeload.github.com/dbos-inc/dbos-transact-ts/tar.gz/
with that exact SHA. SHA256 dc6df527cc91c74a07fc2e71de4426cdddd7765a2540a38ebe15794241d550ca.
Archive and extracted source retained for comparison; root MIT license read.

Hatchet main pin: 4be0bdc7b96c33579f134d859960d4345035cd40 (2026-09-07).
Same codeload pattern for hatchet-dev/hatchet exceeded the 65,000,000-byte per-file
bound (curl exit 56). The partial archive was inadvertently passed to tar, which
reported truncated gzip input on bundled frontend video; this is an acquisition
failure, not candidate evidence. Partial archive checksum is NOT valid provenance.
Observed cohort size 146 MiB. Remove the exact incomplete Hatchet archive/extraction
and use pinned individual implementation files instead. DBOS source remains intact.

Cleanup verified by exact removal command: partial Hatchet archive and extracted
directory removed. They contained only this failed public-source acquisition.
Next package: @dbos-inc/dbos-sdk 4.27.6, registry gitHead
ef3534036901fa4f54d5eb6c4596e34fcf7d939f (different from source-discovery main).
Registry tarball integrity sha512-mr5CEllYovAHPh/TpQcvxTYM+4t4tgV7CjkZGe7hzNxw9Nzf6l7ggxJKDbewLFwgwx8NaWcWw21ESHXNE1UwrA==.
Install only under this disposable root with isolated npm cache and /dev/null
user/global configs, ignore scripts, omit optional, no audit/fund. Record resolved
lock and package implementation separately; do not attribute main-only APIs to it.

First npm invocation rejected duplicate /dev/null user/global config before install.
Distinct empty root-owned npm config files fixed setup; 22 packages installed,
no lifecycle scripts. Added pinned @embedded-postgres/darwin-arm6418.4.0-beta.17
(one package) for the separately authorized disposable database experiment, again
without install scripts. Final resolved lock retained as f1-package-lock.json.
Observed root size: 222 MiB. Native initdb could not load a missing ICU symlink; no
server started. Its exact pg-run child was removed. Script-specific authorization
for the inspected 17-link hydration step is pending; no installer script executed.

Hatchet selected raw files at the above exact SHA, source prefix
https://raw.githubusercontent.com/hatchet-dev/hatchet/4be0bdc7b96c33579f134d859960d4345035cd40/:
- LICENSE -> hatchet-LICENSE, SHA2567388b34bd1ad4b9db3c72dcb73f434ea27c88e5ca8f02a24d4f970c906d79be3
- sdks/typescript/package.json -> hatchet-package.json, SHA256bc2203a53189bba285b3556f2e211a07a6f660015813ce384941296b00ad4257
- sdks/typescript/src/clients/admin/admin-client.ts -> hatchet-admin-client.ts, SHA25641742ac76f9065ae63f867bede5769739ad94a31fd4256c66c390b8f6929c645
- sdks/typescript/src/clients/admin/admin-client.test.ts -> hatchet-admin-client.test.ts, SHA256b1ae4948875e15685f479bb46b6a998d97f30fae48d8cc72ebf5c55f29445b50

Retained F1 root remains needed for the next experiment; no running test server or
agent. This is explicit retention, not claimed cleanup. Final cleanup remains due.
