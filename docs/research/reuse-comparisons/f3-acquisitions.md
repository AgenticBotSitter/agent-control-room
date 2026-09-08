# F3 acquisition and cleanup ledger

2026-09-08. Authorized public isolated evaluation. Pre-download disk 140 GiB free.
Owned mktemp root: `/private/tmp/control-room-f3.oeXTN1`; limit 200 MiB.
Peak observed allocation 1.5 MiB. No installs, agents, credentials or services.
Prior E04 root `/private/tmp/cr-e04.eFL8Ow` was absent; sources reacquired, not claimed reused on disk.
Public web metadata open returned safe-open/internal error; direct public curl downloads succeeded.

Desktop pin: `3f744975f818bbb40ed029e6b3022cd0c5ad7a24`.
WebUI pin: `e168b67e4278df618d1cab61fdb3a8dc55b29a81`.
Source prefix: `https://raw.githubusercontent.com/OWNER/REPO/PIN/`.
Desktop owner/repo `fathah/hermes-desktop`; WebUI `nesquena/hermes-webui`.

Desktop ActiveSessionsBar.tsx/test.tsx and chatRuns.ts/test.ts reside in
`src/renderer/src/screens/Layout/`. WebUI sessions.js/workspace.js reside in
`static/`; Python test names below reside in `tests/`. Both *-LICENSE files
come from root `LICENSE`. Tree metadata URLs are
`https://api.github.com/repos/OWNER/REPO/git/trees/PIN?recursive=1`.
These mappings plus exact filenames cover every acquisition (12 files).

| Local filename | Bytes | SHA256 |
| --- | ---: | --- |
| ActiveSessionsBar.test.tsx | 2165 | 35b0698637477b4af23555e32d7d57bd743cb942b8cc217528e472286f23f364 |
| ActiveSessionsBar.tsx | 3757 | 61eea6c02fbc832136c5b50cd30d785a1ff774989adb29a0af8be4eb30f736c8 |
| chatRuns.test.ts | 5831 | 8d1e0808f61904b7ce1d54166ea938f35102392e4cadf7309198312893afa1df |
| chatRuns.ts | 5433 | 87bd21df4b23ccbc0494c5e95ae4f0db2cdfa92adfb48a3a39b03d78077993c9 |
| desktop-LICENSE | 1074 | 85d12b0f8894e7095f904a9a89fcfaea1b0d037cbfb4a12aba81daa87bcdbcd4 |
| desktop-tree.json | 344473 | c1c88f290895623c500689df3e33668e85bf95013e025bcae3e64eada53f80be |
| sessions.js | 447250 | 598be491bc0a4309d6cacfc04b7b15a0aec192569e7098f2a8cc68c835bfbcb3 |
| test_3845_keyboard_session_nav.py | 3916 | fe9906089ce3ac5e378d996f77c231b2aa6eb67659778926e48ffecf1273cd38 |
| test_cross_session_message_load_isolation.py | 26318 | 9dff8389f1143260923d25d2e5e70fcc0443eae3e50e112387e16ff9ccf7f796 |
| webui-LICENSE | 1083 | ad6b89c03f01d83966cb8bff66986090abc9ae3a3a7fff710a7501c233d7d4bf |
| webui-tree.json | 598398 | 4d7af7659528156ed0ed21221f66335c5f06c2d3d0867dd9fb2a8c7b991aa613 |
| workspace.js | 64454 | 494f3a047bdea0cb19963504fc19e84c571fb39aee28015e7bfa2e60f1188d0d |

All downloads are public source/license/tree/test text. No package media or executable
was downloaded. Real selected source was executed using existing Node/TypeScript/React;
all commands exited. Sanitized outcomes and exact source fingerprints retained in
f3-ui-fit.md and research/reuse-comparisons/f3-exercise.mjs. No upstream code copied
into production or retained as vendored product code.

Cleanup completed: lsof returned no open files for the exact root; all test handles
were terminal. Removed only `/private/tmp/control-room-f3.oeXTN1` and verified absent.
Approximately 1.5 MiB of disposable public source/metadata was removed, recoverable
from the pinned URLs above. No user/production data or other cohort was removed.
