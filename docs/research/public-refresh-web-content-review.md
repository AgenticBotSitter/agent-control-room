# Public refresh web content review — complete assigned coverage

Private planning evidence only; not for public export. Review basis: private bc0a61a0fc22e1b58a5322bde52df8bf74ab9b5b; public main 42ecea2117852991eacf014b8228551e79a061b7. Candidate set: changed/new src/web/v1 members of public-refresh-build-closure.json, excluding private-database-preflight.ts (root-owned schema reconciliation).

## Outcome

All 66 assigned files, 589,398 bytes, were fully read. No embedded private credential, actual owner identity, personal host filesystem path, or private deployment hostname was found in this assigned source set. All candidate SHA-256 values matched the build-closure manifest after the final full-text read. Exact path/hash/fullContentRead records are also saved in public-refresh-web-content-review.json.

This is narrow publication-content evidence, not security architecture approval, runtime correctness acceptance, dependency-license clearance or deployment authorization. Root retains final sanitization/publication approval. Transitive imports outside these 66 files and private-database-preflight are not covered.

## Method and fidelity

Complete file bodies, not just diffs or keyword matches, supplied affirmative coverage. Public current file hashes were compared read-only to identify changed/new files; this does not claim full rereading of all old public bodies. Large candidate files were read in consecutive bounded segments through EOF: private-process 1–220, 221–440, 441–EOF; private-task-startup 1–190, 191–390, 391–EOF; task-coordinator-lifecycle 1–190, 191–EOF; task-execution-planner 1–200, 201–400, 401–EOF; task-assignment-coordinator 1–180, 181–360, 361–540, 541–EOF. Other files were read complete.

The earlier 40/66 partial report is superseded by this completed coverage. A prior combined read of access-verifier/browser-client/project-http/news-refresh-client was truncated; all four were subsequently fully read. An earlier installed-native-queue import truncation was repaired with a complete reread. No truncated output was counted as complete coverage.

No application code, test, service or provider was executed. Read-only filesystem/hash inventory commands only; no network, installs, export, commits or public-clone changes. Report and coverage JSON are the only outputs of this packet.

## Concrete findings and preservation notes

- Identity, trust, keys, tokens, integrity keys, certificates, usernames, host/database names and callback parameters are runtime inputs—not embedded secret values. Publication of this intentional generic architecture is not a content leak.
- private-owner-bootstrap uses https://bootstrap.invalid for a synthetic internal Request; access-verifier uses https://return.invalid for validation. These reserved origins are not owner infrastructure.
- private-node-handler explicitly permits http://127.0.0.1:3000 only for the contributor-demo factory and requires loopback for the private handler. These are generic local-development constants, not a personal host identity.
- Browser modules use relative API routes. No owner domain, personal absolute path, Alastair identity, named private agent, or Content Blooms branding was found in the reviewed source bodies.
- abs-research-draft contains “ABS source-backed work proposal”; news-wire exposes abs_article_draft. Other news/task modules preserve abs/ABS identifiers and generic Control Room branding. These are product labels and protocol identifiers, not credentials. Root may deliberately generalize display branding, but should not accidentally break identifiers.
- news-reading-view imports ../../vendor/control-center/industry and types. Preserve the corresponding vendor license and third_party attribution. This report does not independently clear that imported tree or the full dependency closure. No attribution-removal finding was identified in these web glue modules.
- Approval, envelope, transmission, coordinator and planner modules contain parameterized signatures/HMACs, canonical identifiers, SQL and runtime guard logic—not saved live records or literal secret keys.
- Startup/host factories can acquire databases, start configured workers or listeners when explicitly invoked. Publishing those definitions does not configure a production target or authorize invocation. Preserve the source comments separating inert construction, explicit startup and deployment authority.
- Some comments and module names say private; they describe protected application composition and are not evidence of a private value that must be suppressed. No recommendation to hide generic architecture is made.

No redaction is requested from this assigned source set on the basis of embedded personal data. That finding is not permission to copy or publish and does not supersede root's public schema reconciliation or complete export/notice review.

## Exact fully read coverage

| Path | SHA-256 of private candidate | Bytes | Public comparison |
| --- | --- | ---: | --- |
| src/web/v1/abs-research-draft.ts | f772f0859dbe815fd55f79bcfd81bb75332d810982f3cdf85e4ff656453ad104 | 2229 | new |
| src/web/v1/access-verifier.ts | b51bc1fcde7c6c1790bd46a6ed9f3544aa808456c7b966b51d232038c2472426 | 6113 | changed |
| src/web/v1/bounded-queue-worker-startup.ts | e4f40a6e6b8638fd034c9b741039c9e3bbe034e2c010e18af9ecd9e278fc2d82 | 6078 | new |
| src/web/v1/browser-client.ts | 7955b5e565775805f167a9c8bef50565d264bc8c956c2fd2ad4d38b06462ef9c | 8893 | changed |
| src/web/v1/idea-browser-client.ts | 219c1a4380e8994dc0ce2ac5a9d9f8afdcb6837aa9829d2ab46ecef297194d16 | 2330 | new |
| src/web/v1/idea-create-client.ts | 2c9d5f9111bac34d421066cef73cfc7896d4f3c601de7c51426067e95769c924 | 3004 | new |
| src/web/v1/idea-create-operation.ts | 8d6302569e8af6fba2169033a5461e42755d933ed3e23829e4d9ae3b8df4af79 | 9469 | new |
| src/web/v1/idea-decision-client.ts | 14ad75b8035bd2a68d2bd833eda35be3ccd4ed3457894780338742775d5acc4a | 2644 | new |
| src/web/v1/idea-decision-operation.ts | 2ecb9d50e8823aca3deced0bd7db5fc40c5462136d9e635a247e053500667320 | 6350 | new |
| src/web/v1/idea-detail-refresh.ts | 5619dab8583a1e479bb4c692f4d86496d723cbd17bedcd73a00efc5ae1d80d71 | 1841 | new |
| src/web/v1/idea-experiment-draft.ts | 112faed0edfdb2ea7308d7c37e565e28e8af5be36ab309725d525a5c3e4326e4 | 2190 | new |
| src/web/v1/idea-project-lifecycle-operation.ts | ab285c990220126dd2bba3018794e82a91b6e9035161038842b34f36105f10d3 | 5625 | new |
| src/web/v1/idea-service.ts | bcfe2b4f8c667297a0512d50021d5264e8cd84eef2ca1a6bbc069b2a5f3055c5 | 6662 | new |
| src/web/v1/idea-start-client.ts | c3a66c6e4fcfd1d37625bca29ca11feef4ee56a389e32e986c22f8807ea4742e | 1889 | new |
| src/web/v1/idea-start-operation.ts | 3ebbc8c1f7f43667131023a062661370bfcfddcd1756bcf71599f6d9aa8a32fc | 7578 | new |
| src/web/v1/idea-stop-client.ts | 7cfe21b04c68749f4bf8a78d002a0f846d55ab1d08eab87c548ef61f32ec9f16 | 1825 | new |
| src/web/v1/idea-synthesis-client.ts | bdce08ad8127229b52359a200b257f259e23a688e081603bc3413c63e0792564 | 1855 | new |
| src/web/v1/idea-synthesis-operation.ts | 994542f75c663b3e8ecb05f7f9afe11e4bf3f3d32225f4017073b13375600244 | 4473 | new |
| src/web/v1/idea-wire.ts | 66eddf9cf986f662a6faf7ac5be763549334588f7ed968232b8375d9051063af | 9152 | new |
| src/web/v1/installed-native-queue.ts | 83e36923e670ddd9c0c4cfd28ae88f1738d33e606b7598b7ee65b5cf51da4d71 | 2830 | changed |
| src/web/v1/managed-native-input.ts | 4fad0217c8e4066f9d6cefe9524df378c6d8f9ad30da67b311b929cab9ea8ff1 | 10627 | changed |
| src/web/v1/managed-native-sessions.ts | c3203a08920b1d7ca3f1236a7e7c510d2b048bc21f25ec103314fb9015ac88ed | 20023 | changed |
| src/web/v1/native-approval-packet-store.ts | b9c78e5184034860adff86dcc18a6a8be34aaa5e5ddabd27aa27236c060f79cd | 16391 | changed |
| src/web/v1/native-delivery-envelope.ts | f34ac4fbe906a80b714a04b01b67ecaea6c51811fd43e7bdd7b900ed5efb6d0b | 5896 | changed |
| src/web/v1/native-http-host.ts | 44ad8c13966195f76dca7ff4f56f0a4e8a568bd2d89d5c127f7246cb4ea461e0 | 13135 | changed |
| src/web/v1/native-queue-worker-startup.ts | 0d414f091564f0b99661cff137dabcb5c4789a5b49fe79b49ccfaafc4190804b | 1176 | changed |
| src/web/v1/native-transmission-intent.ts | 0f410c09a4fce76c86ddef214a089fdb6072f1be7a849c4d870771fc9bc341e1 | 4833 | changed |
| src/web/v1/news-archive-client.ts | d2095f847facca5fd908ce8ce3011596585aa4719ceb6f18efb9f06bc55c7494 | 3029 | new |
| src/web/v1/news-collection-admission.ts | bc62b51abf167d98ef2b6c8de00e36bb90ea9cbfdc69ea576a36ea80698ddc88 | 12572 | new |
| src/web/v1/news-collection-planning.ts | 5b84c38c2f808e8b376d0e75bfb3d779de6603759dffa7cb0b0c01af6d9bf97e | 13604 | new |
| src/web/v1/news-collection-status-wire.ts | 4d9a24e25d40ec836e6cf3f2496a9d72d229152606045e7fa698dd7da11dc975 | 2842 | new |
| src/web/v1/news-discovery-integration.ts | 238d9017b8f8fb4dfa457dca207a13eb8d6715ae73b4a8fab97bb30af3b44699 | 6107 | new |
| src/web/v1/news-navigation-guard.ts | bca534bacfe20595b095004b1b95b9fa9dabe5beb1bf564387e93cb360aa77bb | 1013 | new |
| src/web/v1/news-queue-worker-startup.ts | 7e9407ceecf8b50369b8db4c177b3b65de556ac454567894160c066eb835446d | 2481 | new |
| src/web/v1/news-reading-view.ts | a51b27f89aa79bb6f443c6a98b8517e9d7744db5b636bafbb576aec7d40003fc | 1509 | new |
| src/web/v1/news-refresh-client.ts | 06cd91a6ecf536181f0649a625226ebd2a29cb833c84410dcf986443dec28fda | 8902 | new |
| src/web/v1/news-service.ts | 19fa9503d8c775707f3b9088da4693f94736dc4db27f06378d4d716ab95fc2b2 | 10997 | new |
| src/web/v1/news-source-client.ts | 87957895b12f14c060606f94eafad7ac87be02c549f5316434af5436cad739be | 4695 | new |
| src/web/v1/news-startup-configuration.ts | bee1ae7135c1bf1b861ba9bfed5854390f78d691f2a39dca9541099c594f0701 | 2684 | new |
| src/web/v1/news-status-observer.ts | c27d74b0c3d469a343e50b5fdba7994c14ea8a033f672abe3499430d27d1b1ba | 1353 | new |
| src/web/v1/news-wire.ts | 9f98f192f216b06bd5243b0f2765d8eea851aea4c8b50104fabbdc5e80ac5add | 2988 | new |
| src/web/v1/private-idea-authoring-startup.ts | 5e835df728cd41691e248ac9e6a0ae6d62803659d05e5d5db328de6bbcf797c9 | 7181 | new |
| src/web/v1/private-node-handler.ts | a8158352d53481f68f192e1972fb5cd51bcc75f986a7c49b93bf32787239bf69 | 13812 | changed |
| src/web/v1/private-owner-bootstrap.ts | a562fe42b7010de891ac411ac782eb93543259184befb2b150d4743a1a024e39 | 7051 | new |
| src/web/v1/private-owner-review.ts | db8db0ab63f52d7bc319cf81b2725343aaeb17a4c2f44a00da70e3137217e54f | 1196 | new |
| src/web/v1/private-process.ts | 79b5261c991634e61f6c89a15fe94e759606448b619b28c838adf6929a9b4aea | 39887 | changed |
| src/web/v1/private-startup.ts | f0306ba5917fd1501be9a417c25f976962900930530046643b34ff3e75679ffd | 7180 | changed |
| src/web/v1/private-task-application.ts | bfb753c04d2d1bb82dd3ce4f02640cb8dedc97db020deb79ad7b81e630726e06 | 4893 | changed |
| src/web/v1/private-task-database-check.ts | 7ae2e933f6716281236e50894ed8f0e0594963b9c8fff661dc6624359c3380e0 | 5871 | new |
| src/web/v1/private-task-host.ts | f7d40bffd3b08d27c0e9f3d590b0489045079f2ee9dee55819e7a897a55d8963 | 5169 | changed |
| src/web/v1/private-task-startup.ts | c7992c3bedf487da22441cea1a0f3dd75882620d74e4192c0ee63baf1f073c9f | 32976 | changed |
| src/web/v1/private-task-worker-application.ts | afa137f2f0d0db95a8311d29e2428bcb5016a71d913309786769bc7034389536 | 2952 | changed |
| src/web/v1/project-http.ts | 8a824353ddf0b819b8c1f8c2e0d60bd8602b21909a1b8348c55bca34aedad7ff | 3800 | changed |
| src/web/v1/project-service.ts | 27ceb0dbe183ce36cbd9b4785f1de01df73dce978ba5559cce8ea36e1554a989 | 16676 | changed |
| src/web/v1/project-wire.ts | eb1c72128bc012b9f5a11b5c0433f5ce03589b153e89a007c0ae4abd7864e8f7 | 2980 | changed |
| src/web/v1/task-approval-browser-client.ts | ba2bcae73ef69045a0069a159d824959873464c998e8e0ab7da4db4d6af2f301 | 7849 | changed |
| src/web/v1/task-assignment-coordinator.ts | 84480cfdaddd2bc400b9e0fdd75d9f7ad85c470a96d379dac857d1ca67689b81 | 49366 | changed |
| src/web/v1/task-browser-client.ts | df017b64e719c6b02ae8204a7071a12823e3fda029821aa4002087b6a5d3dd53 | 9305 | changed |
| src/web/v1/task-coordinator-lifecycle.ts | 980130992507a36ac8b3661bc210c9c347895ff1bac43529f0eb7a4d135e1c7c | 28813 | changed |
| src/web/v1/task-execution-planner.ts | 5a8443697a3ffb9813dd83ca64d8296017b94a97ab029b93366b9e31641ca31e | 34766 | changed |
| src/web/v1/task-execution-workspace.ts | 28876d7d86c54fd465122a5bdce39ff6827cf1d4f893639dbe2dd49bea96bbe7 | 2639 | new |
| src/web/v1/task-http.ts | 9874644900e425edd03aeebe9bda0bc7d09a233571b1ca9a823ce9e73e96c6e0 | 18808 | changed |
| src/web/v1/task-result-coordinator.ts | 41995da2d48faf5d877fc9976da807f2ad73b9db77797caa1b09799e650a6d61 | 7651 | changed |
| src/web/v1/task-review-workspace.ts | ed48bc6ee643345fab58b650ae0c48826443f3944d3902a50a54be81cbd769c3 | 4379 | changed |
| src/web/v1/task-service.ts | 6ae896ff7c561db8530c000800b9770525fc240ed89e6606635f6e255a36b942 | 30047 | changed |
| src/web/v1/task-verification-workspace.ts | 545d04f2a2586388e13182e61d9871e3c749709c421f60e8120785d000476184 | 4264 | changed |
