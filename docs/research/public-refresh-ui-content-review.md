# Public refresh UI/content disclosure and attribution review

2026-09-08. Private base `bc0a61a`; public local main `42ecea2`, branch
`codex/sanitized-source-refresh`. Independent full-content review, not architectural,
security-policy, functional, legal or publication approval. Root owns final export.

## Coverage and result

Read the complete contents of all **57 selected files** below in bounded chunks:
23 private-app UI files (including six already staged Idea files), 24 ABS adapter
files and 10 Control Center vendor files. Compared exact bytes with the isolated
public candidate; six Idea files already match, remaining 51 differ or are absent.
Recomputed every listed SHA256 and matched the build-closure receipt. The initial
whole closure JSON tool output was truncated; it was not used as content review.
Selected source reads subsequently completed without truncation, including split
reads of long vendor/schema/store files. No unexamined closure files are approved.

No embedded credentials, personal customer records, private installation addresses,
owner host paths or removed Content Blooms branding found in this selected content.
This is scoped source-disclosure evidence, not proof that runtime data is public or
that the rest of the 546-file closure is safe to export.

## Concrete attribution condition before exporting this cohort

The existing public `third_party/control-center/NOTICE.md` describes only the older
`industry-events.ts` adaptation. It does **not** account for the newly proposed
complete curation, discovery/source-reader, reader UI and HTTP modules. Update the
public attribution mapping alongside these source files; do not publish them under
a misleading old-only inventory.

The private complete notice was read in full and supplies donor revision
`d13e79e866cc33a1fddfe84f563ce2fb9a2113e0`, original paths and local modifications.
It covers `lib/{industry-curation,industry,feed-discovery,freshness,sitemap,types}`,
`lib/server/rss.ts` adapted to injected `source-reader.ts`,
`lib/server/{public-address,pinned-fetch,safe-fetch}.ts`, and
`components/daily-snapshot.tsx` adapted to `news-daily-snapshot.tsx`.
The full retained MIT copyright/permission text is required with copies/substantial
portions; copyright is Matt Wolfe, 2026. Project Apache does not relicense these
files. Preserve provenance and accurate modifications; a root-license badge alone
does not account for dependencies or final bundles.

Read notice inputs and hashes:

- `third_party/control-center/LICENSE`:
  `a149b592d1e38b71a4ff4987ee9020b5f35a5fe7c2f09ebdc78ae9ec7a87349b`.
- `third_party/control-center/NOTICE.md`:
  `06b381e0a31599c5c90dff1eb3eee093f22d6080e68d892b551c24253cebbc48`.

The notice's E03/research wording is historical provenance shorthand, not an
embedded host secret; the public copy should remain self-contained rather than
require access to private evidence. No upstream-source authenticity/network check
was repeated. Exact dependency notices (rss-parser/fast-xml-parser and their
closures), built/external inclusion and whole-release license assurance are outside
this source-content packet and still require root's release inventory.

## Embedded labels versus runtime data

- `action-catalog.ts` contains **Draft an ABS article**, `route.abs.*` IDs and
  capability/profile labels. `types.ts` contains `project.abs.ai-tech-news`,
  `workspace.abs.news`, `adapter.abs-news.v1` and action identifiers. These are
  code constants, not secret customer record values. Root explicitly confirmed ABS
  is intended public AgenticBotSitter feature naming under the owner's attribution
  approval. Do not silently rewrite digest-bound identifiers while sanitizing.
- Story titles, summaries, project/customer descriptions, participant display names,
  canonical URLs, node/provider/model names, receipt digests, file names and dates
  shown by UI are supplied props/API data or generated identifiers, not embedded
  live owner data. The Idea create form's customer/title fields start empty;
  numeric default budgets and fixed generic research prompt are not private data.
- Vendor types name credential/token/client-secret fields but contain no values.
  `googleClientSecretSet`, `credential?: string` and `apiKeys?` are type
  declarations, not credential exports. Provider names and Google/Bing wrapper
  hosts are generic implementation constants. IP ranges/localhost strings are
  network classification/refusal rules, not disclosed private infrastructure.
- Paths in fetchers derive from configured URL arguments; atomic write paths derive
  from caller targets. No absolute user home/profile path is embedded. Source-reader
  injection and dormant helpers do not themselves authorize network/filesystem use.
- Relative `/api/v1`, project routes and `/cdn-cgi/access/logout` are generic
  application routes. They do not disclose a particular Access tenant or private
  hostname. UI warns signed permission is separate and not an agent start.
- No article/newsletter body, actual feed URL roster, owner key, session cookie or
  real approval file is seeded by these modules. That does not certify whether
  deployment responses later expose authorized runtime data correctly.

## Limits

No source was copied or edited, no dependencies installed, no tests/services
executed, no network/credential access, and no public Git operation performed.
Filesystem reads, hash comparisons and local Git status/ref reads only. Architecture,
schema correctness, source-fetch authority, UI auth races, live support and final
publication are intentionally not approved by this review. Other public tree
changes, migrations, helpers, screenshots and untracked assets are outside coverage.

## Exact full-content inventory

“Prepared match” refers to the local unpublished public candidate, not remote
publication. “Different/absent” requires root's separately approved copy plus checks.

| Fully read source path | SHA256 | Compared public candidate |
| --- | --- | --- |
| `private-app/app/idea-create-form.tsx` | `f9391cbdad4b462560d5062273592ba3b23f044b0a1688780aa549a666efc560` | Prepared match |
| `private-app/app/idea-decision-form.tsx` | `186f31f4e91bb909e067ecfdf87229a4b20af0395c5112da49e067f935175ba8` | Prepared match |
| `private-app/app/idea-start-control.tsx` | `9fb97bccdf7c9e152d58be2e37bbda4eae0a6d39ccd54345cdb10997fef55499` | Prepared match |
| `private-app/app/idea-stop-control.tsx` | `f910a224cdd7969eb0c229bb6dd108a651006188182647d893767f974a9e4b31` | Prepared match |
| `private-app/app/idea-synthesis-control.tsx` | `960642363984d8f3ee21883f460997d1fa72088d5c0681c85e1b22d21356b722` | Prepared match |
| `private-app/app/idea-workspace.tsx` | `7f80be3cdad304d79c5684dfeb6ea3a4a926c11002d60d718efb4ba7a5b1e85f` | Prepared match |
| `private-app/app/ideas/[sessionId]/page.tsx` | `9e88813d50ac1bf8b4112d2083af5b6df9016ad60f81c7bf1cf05d28a18258ec` | Different/absent |
| `private-app/app/ideas/page.tsx` | `b01c30da13fc1285e4af115827562ce2cf2a84750efbffd319a1832903f5b669` | Different/absent |
| `private-app/app/news-collection-history.tsx` | `ea2692d49b785e2d33e471b7453028971faa306945f23ba6fc96c74eb54b5a68` | Different/absent |
| `private-app/app/news-daily-snapshot.tsx` | `0ad4236a58da06c5f4f981e891d1eab73fc0b0e1db380b2d634be127903a74e3` | Different/absent |
| `private-app/app/news-research-form.tsx` | `c2df5c693275b090a287e64131bd0cfbdb4c3b1a7dd0b0d942b0fcc742ac0e37` | Different/absent |
| `private-app/app/news-source-refresh.tsx` | `971335ce7f437a63228e94b5e48c6a351b6234100b24c0c72e533a4445e49bac` | Different/absent |
| `private-app/app/news-source-settings.tsx` | `3e75797141373c82bea052117dccb2ad0fcbd6ea7a524729800c8c21c75024e5` | Different/absent |
| `private-app/app/news-workspace.tsx` | `305d295159c0d0c3df195ab0a0790f7ff4bde74c5941c218d77cd0048f45bd30` | Different/absent |
| `private-app/app/private-header.tsx` | `94ebb281cefc1bb0bfc6a4c110edd6b4c3935105fa0ee8969929c35d8182075c` | Different/absent |
| `private-app/app/projects/[projectId]/news/page.tsx` | `33a45e8a3ac70122b9b04a22a341b1f0aedd05ff56119762e0d6b784315c72e7` | Different/absent |
| `private-app/app/task-approval.tsx` | `3ef7557bb8986195061aa63b74572916ebb9b83e72cd4bb3935267204e26c697` | Different/absent |
| `private-app/app/task-assignment.tsx` | `2e8f98907b4aeaf1215c090ab339c075e2e26d7962ba54a420c5dfa60724318c` | Different/absent |
| `private-app/app/task-panels.tsx` | `f59d6a8d0ecf30468a2ebd499c784dd88d5160036e93a74fc5227e36de242f29` | Different/absent |
| `private-app/app/task-planning.tsx` | `9ce60e23a7f8d86d3501f782ad4b6f7b405f88baa814c13fc50082a24658ff71` | Different/absent |
| `private-app/app/task-submission.tsx` | `1bfcee2d105403926dd5b905336b33a2143a0ad15b466ed00e0682422d486882` | Different/absent |
| `private-app/app/task-workspace.tsx` | `ca755ae68d4f6451bead3dab5f47950da20b443ca510d860d74054c735f47316` | Different/absent |
| `private-app/app/workspace.tsx` | `b25906afc1caabfdf7fd1a7d5bded0e4fa9a81f8ad4b9e018bd1fa70c556ac71` | Different/absent |
| `src/project-adapters/abs-news/v1/action-catalog.ts` | `ec3af8127fff8b86f958992cb4ac7572ea160897e79242daef43438811a0df06` | Different/absent |
| `src/project-adapters/abs-news/v1/collection.ts` | `dffc30a5d4c657cdc1912a601dd1f764e62f9259db9d71d275b5ceed495eca45` | Different/absent |
| `src/project-adapters/abs-news/v1/configured-collection.ts` | `395978d4719deddbfd04bb7b5666e0d1fe1a876e4e8c0822ce5502018a38e794` | Different/absent |
| `src/project-adapters/abs-news/v1/control-center-collection.ts` | `3e5db908d28bf4a84b362f4eeef112c32c05ed725b3edb1d0a06e78af9a782f9` | Different/absent |
| `src/project-adapters/abs-news/v1/control-center-ingestion.ts` | `036294ddecb4d1a1ea454e53252d747ce30e159a2360f9576a90b20a16e3c0e2` | Different/absent |
| `src/project-adapters/abs-news/v1/control-center-reader.ts` | `b79745d2980fa778f4e2302de2fc87095a642102d19155377f7cdba568a7944a` | Different/absent |
| `src/project-adapters/abs-news/v1/current-source-authority.ts` | `cb1e90b56ba8ebe5996ba483f78b977979c94d8ec2e131f690b24a5cf77e7187` | Different/absent |
| `src/project-adapters/abs-news/v1/discovery-baseline.ts` | `f991397160b7a856792c7db2774324a87848af1a550f44f2c6ee271a98556449` | Different/absent |
| `src/project-adapters/abs-news/v1/discovery-ingestion.ts` | `56d3073749659376b2ef6c618eb406b77787dd4ca7af22d425863eb9d20775e2` | Different/absent |
| `src/project-adapters/abs-news/v1/discovery-job-configuration.ts` | `8fac26cc90102c659cc7a936442d8495357c290e166d5f5b9ffdfcc9b9b1464e` | Different/absent |
| `src/project-adapters/abs-news/v1/feed-collection.ts` | `d76395857ef823201ffde21280d6383e5e41ad95e994ab0b2e64bfb9ddc4e42d` | Different/absent |
| `src/project-adapters/abs-news/v1/feed-decoder.ts` | `51fd92b54010953db81e64383f6bb60abfed977a5918a528a0b497ed244e9409` | Different/absent |
| `src/project-adapters/abs-news/v1/feed-ingestion.ts` | `bea7c03a43d0dba664a77cc31572135795e6a1615ceeac20e26b872bdde0fdbb` | Different/absent |
| `src/project-adapters/abs-news/v1/feed-job-execution.ts` | `70d28331ec145cc6a59d42b12f8e3969c48ee24d64820f0e15a93567e3702871` | Different/absent |
| `src/project-adapters/abs-news/v1/feed-job-plan.ts` | `58c00f05666ddf412d232829921c45d162371edf9b01685f55ce6cd1fd521cc4` | Different/absent |
| `src/project-adapters/abs-news/v1/feed-plan-store.ts` | `c1cfde8508d34aa40ca6d4e7d045ac3ae2752e541cbef841e5490bdb0b6cb6fc` | Different/absent |
| `src/project-adapters/abs-news/v1/postgres-store.ts` | `30cc63561d98edc42bd3d50b1caa27e45f0049b9136095ac0ef1ac98314849fb` | Different/absent |
| `src/project-adapters/abs-news/v1/proposal.ts` | `e83dcfe558afb7661b5523e6fa1882c8e5571324cc994688af722337297663d7` | Different/absent |
| `src/project-adapters/abs-news/v1/public-reader.ts` | `f077de34fdd045420211061926871f23b4d2bc15b3b27bf30d8a7a4218fd19a7` | Different/absent |
| `src/project-adapters/abs-news/v1/schemas.ts` | `99d2d1257dc1d74b01b67ca3adfe1325299fecde584952912e26a2257e8938c5` | Different/absent |
| `src/project-adapters/abs-news/v1/source-settings.ts` | `cb2d2dae0c72380e1eb7a3308cb175bbec006df56bc3917f1e594ade6843357b` | Different/absent |
| `src/project-adapters/abs-news/v1/story-archives.ts` | `cb631af6b5b1bb7642505550be0842918cdde186e1edde30d25aa75b66d79b16` | Different/absent |
| `src/project-adapters/abs-news/v1/story.ts` | `1aa81ffd78f8c6e39e0d21a3d4de4a0b0a0688af2b13fef6fb6358a0cff27100` | Different/absent |
| `src/project-adapters/abs-news/v1/types.ts` | `7b6806e730d7c6a44bf7406e7f9b4879b232c55ade2ef3d016b2ca7f483b23f9` | Different/absent |
| `src/vendor/control-center/feed-discovery.ts` | `d94449d6b86ff873096c36d4ce7943f9afd473ba19183217b865bf6f5dbc8974` | Different/absent |
| `src/vendor/control-center/freshness.ts` | `dc691c41b2b0707626d2589866aa2fa1d106e4c8a1190e376379ac4582e410ca` | Different/absent |
| `src/vendor/control-center/industry-curation.ts` | `ad668fe4bf08e7b48913b43ef7edb05edbe4d874db1a16c451ff006e0b70d962` | Different/absent |
| `src/vendor/control-center/industry.ts` | `9ca39a9ad88f16262a2551a99de016a5ed951c7a53ba6a7a36362e061779db8b` | Different/absent |
| `src/vendor/control-center/pinned-fetch.ts` | `1fafc239bb2a06038c2c7f54d0026f736e64f938ff37976e075b2021e20112ca` | Different/absent |
| `src/vendor/control-center/public-address.ts` | `291fc245b943c48feaeb5807ef5f60b1ec8b31f0f8f6cdd7782c998be0c6cb48` | Different/absent |
| `src/vendor/control-center/safe-fetch.ts` | `a1357f764be50e705d79da4d261fbba38a72e392e7818480560b9d445287f733` | Different/absent |
| `src/vendor/control-center/sitemap.ts` | `732d0a11901eb340925ac0aa8d636e43d31b7296aa79306a81147048eeda4f7e` | Different/absent |
| `src/vendor/control-center/source-reader.ts` | `81e03fc3f97b3d5729bc96044e27cbd19c27536c9bb82a906fba5f500ccff9ab` | Different/absent |
| `src/vendor/control-center/types.ts` | `25d5046f5e6c1ce2897144cba5e39797b77a2143628d82cceb3ebea014ad195f` | Different/absent |

