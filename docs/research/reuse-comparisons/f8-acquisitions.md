# F8 acquisition and cleanup ledger

2026-09-08. Free space before: 140 GiB; owned root
`/private/tmp/cr-f8-eval.scXjQj`. Limit 200 MiB, no installs or services.
Public read-only Git ls-remote resolved each commit below. Initial sandbox DNS
failed; explicitly scoped network escalation succeeded. No authenticated Git/API.

Each archive used URL `https://codeload.github.com/OWNER/REPO/tar.gz/REVISION`,
curl `--max-time 60 --max-filesize 52428800`; expanded in owned root only.

| Owner/repo | Revision | File bytes | SHA-256 |
| --- | --- | ---: | --- |
| pgbackrest/pgbackrest | 8c8f3ee63e310f0b3ea10b55ed3b96b4cc9296da | 2709589 | 3da993354ebd271841d71912f31cf79f9679b09a74fe1ce635ffa5e944e3dd21 |
| louislam/uptime-kuma | e4821321e559c887b14e37d9979e604b221a8945 | 2196344 | b6914b6210adca6e43f70e630465e5857c9f3c386b1057f8969be8b0a43b55dc |
| henrygd/beszel | 5b87f7d7cb095ac186162e8a8f3967182aa8023b | 1464392 | 9a06602bea868bc49ba3e879416eccb769cc37005ad3a996ea0ca92578ca63c7 |
| authelia/authelia | 296d8f21d0f48ebe69d1f6d03dff1f56e6990a3b | 11927035 | c197e37177fedee3f01928c5dbf2dee830a9216d56de62c4482259be7b1b6ee9 |

Expanded root plus archives: 84 MiB. No binary/toolchain/dependency acquisition.
Only dependency-free Kuma condition JS executed. Root contains public source only;
SQL fixtures are retained in research, not executed by this subagent. Upstream
node tests completed exit 0; no process or listener was spawned in background.

Retained sanitized result: 7/7 local condition checks; upstream node tests 21/21,
2 suites, 0 failed/skipped/cancelled, duration 39.6445ms (test suite duration, NOT
service startup or probe latency). Date and tool commands in f8-operations.md.
All source-only test readings stay E1. Initial glob misses were corrected to actual
upstream paths; no upstream code/test assertion failure occurred.

Cleanup: exact root removed and absence verified after saved evidence; lsof found
no open handles first. Approximately 84 MiB removed. Source can be reacquired
using pinned URLs and verified hashes; no copied upstream product code is retained.
