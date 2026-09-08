# F5 source acquisition ledger

2026-09-08. Free disk 140 GiB before. Owned root `/private/tmp/cr-f5-eval.gXIc0a`;
100 MiB cap, peak allocation 2.2 MiB. No installs/execution/services/credentials.

OpenBao source prefix `https://raw.githubusercontent.com/openbao/openbao/1859768bdb897d92723c68f8457128c9fd707a98/`.
`bao-path_*.go` maps to `internal/builtin/logical/kv/`; `bao-acl*.go` to
`internal/vault/policy/`; `bao-operator_raft_snapshot_restore.go` to `internal/command/`;
LICENSE and go.mod root. Tree URL GitHub API `/repos/openbao/openbao/git/trees/1859768bdb897d92723c68f8457128c9fd707a98?recursive=1`.

etcd prefix `https://raw.githubusercontent.com/etcd-io/etcd/5400cdc39b829ee5dadacb77002256cf86357da1/`.
`etcd-txn*.go` maps `server/etcdserver/txn/`; `store.go` to `server/auth/`;
`apply_auth.go` to `server/etcdserver/apply/`; `v3_snapshot.go` to `etcdutl/snapshot/`;
LICENSE root. Exact public git ls-remote tag + peeled commit retained in dossier.

Each raw file bounded 2 MiB/20 seconds, tree 5 MiB/30 seconds, go.mod 1 MiB.
Failed acquisition evidence: guessed standalone OpenBao KV repo not found; initial
etcd annotated tag object URLs returned four 404s; resolved peeled commit and fetched
successfully; initial OpenBao ACL directory wrong (404), corrected via pinned tree.
No failed path is counted as inspected source. Web reader plugin URL internal error.

| Local file | Bytes | SHA256 |
| --- | ---: | --- |
| bao-LICENSE | 15958 | d6b1a865f1c8c697d343bd4e0ce61025f91898486a1f00d727f32e8644af77d3 |
| bao-acl.go | 27409 | 6e75975d1f7ad3dd52eea2e9a87febcd3c4d7ea0c15965c20bf8b7ed6ecc3a17 |
| bao-acl_test.go | 39507 | b673c3ad53e0622e1c0bd7b96543a56fdd0ef445d324ec1a9c6745dacecc70b2 |
| bao-go.mod | 16750 | 74f59dfdda05f35b6672ddb85da753d877e23678cf2359b8135b75c0d66d7a20 |
| bao-operator_raft_snapshot_restore.go | 2531 | d000a315027a2d2331ecf0203bf5def2fb787dd58070050c4a27217e0b4671f2 |
| bao-path_config.go | 5512 | 466d0712e57029023010a7b2f28d18538dfb2b928d5ae6d9951c40ef6026d58e |
| bao-path_data.go | 22501 | a3ae613f3832365f075c98fab671724c8e1fa810a94d9a2498121b32a5adb04c |
| bao-path_data_test.go | 29478 | ea22232214bcddb2262c18c20ce02cb8da2243c97ef3eb0423be1a122fb1d3d7 |
| bao-path_delete.go | 6594 | 7037d5c0189be1ba07c22a9156586ad95df645b71355d5058b46cba186b74823 |
| bao-path_metadata.go | 25200 | a5f3ce2063a1e709d28c2f084a43a773610b9b07a3159e305981358515e5c5fc |
| bao-path_metadata_test.go | 41032 | 376874384a3e2bc3e77635159696153a880cfeee8535ffdeda3d02a8f4f04e6a |
| bao-tree.json | 1913197 | 727e90898f08c2f1f749563facfa066a61deb40e4bc7798f7545b2c54aa604e4 |
| etcd-LICENSE | 11358 | cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30 |
| etcd-apply_auth.go | 5604 | d72888e1f51e4b632cc6fae42ae30b066e0855c6aa4cc735e355ddc7f59242dd |
| etcd-store.go | 31732 | 8e83843aee12731445eeaf1d34bded316871c80820ce3ba6058f655e2eca85b3 |
| etcd-txn.go | 21129 | 506f3f43ab48b068f24e67e98dd53ceff241cbf864bf3f9248e0c78cdc378a6c |
| etcd-txn_test.go | 17311 | 5461b95096cda772ad10f4f0c2247af6538df835eea19e7bbc2c8109e21c1b04 |
| etcd-v3_snapshot.go | 16251 | 3155cd82119ea71ecd8922e30d2d373a8a2764d4f9894e1fb8a33283dcbb965c |

Cleanup complete: exact root removed and absence verified after evidence saved;
lsof showed no open handles. No processes launched. Approximately 2.2 MiB removed,
recoverable using pinned URLs above. No other cohort or user data touched.
