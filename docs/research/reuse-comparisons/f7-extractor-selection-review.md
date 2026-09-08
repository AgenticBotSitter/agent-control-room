# RC7 extractor primitive: independent selection synthesis

2026-09-08. Source/evidence review only; no new downloads, execution, product edits or final root design decision. Read the Readability, bundled DOM, Miniflux and HTML compatibility fits and independent reviews, F7 candidate screening, and article integration map/review.

## Recommendation to root

**The existing evidence is sufficient to choose Readability0.6.0 with jsdom26.1.0 as the conditional default extraction primitive for the next bounded integration packet.** It is not sufficient to approve shipping that dependency closure, assert broad publisher quality, or close the full reader workflow. No additional unchanged extraction baseline is needed to make this narrow choice.

The reason is a specific integration fit, not popularity or sunk-cost preference: the documented Node embedding returns main text/title and applies base-relative link resolution using a browser-like HTML parser, already ran on the common corpus, handles all five discriminating HTML fixtures, and supports the actual optional upstream readability heuristic. This avoids a custom extraction algorithm, HTML repair layer, or Go process integration for the current Node app.

This is not a finding that Readability is universally more accurate than Miniflux. Miniflux has not run the expanded malformed-HTML corpus, and main-text completeness on representative layouts is not established for either. The choice is justified by demonstrated interface fit and additional integration obligations, not an invented quality ranking. Reopen the primitive choice if actual integration exposes unacceptable extraction quality, deployment memory, dependency policy, or a requirement already better served by an existing external reader.

## Named alternatives and retained roles

| Candidate | Evidence actually available | Narrow disposition / cost |
| --- | --- | --- |
| Readability0.6 + jsdom26.1 | Actual five executed baseline inputs plus caller-gated oversized row; false positive for navigation-only; five new HTML compatibility outputs meet marker/link/entity expectations; two optional heuristic observations. Selected implementation hashes checked; upstream tests inspected, not run. | Default for bounded Node extraction. About40-package tested closure; caller retrieval/admission, output policy, provenance and detail integration still needed. No upstream fork necessary. |
| Same Readability + bundled JSDOMParser | Baseline output byte-parity on tiny corpus; expanded cases produce three incomplete-document errors and two semantic mismatches; optional heuristic throws because selectors are absent. Actual source documents well-formed markup constraint. | Do not select for ordinary unnormalized HTML input. Preserve specialized well-formed-markup option. One-package benefit does not justify writing normalization/selectors/entities to rescue it. MPL file/subpath surface requires separate notices and API assessment. |
| Miniflux pure ExtractContent at a84533db… | Actual unchanged small Go module,230 upstream inline tests and same six baseline inputs. Main text extraction works; HTML retains relative links, no separate title, empty-wrapper and navigation outputs, no max-elements option. Four external imported packages; no Miniflux service/DB required. | Viable alternative, not rejected. Requires packaged executable and bounded Node process I/O/cancellation plus chosen metadata/link/empty-content policy. Existing story title can be reused legitimately; lack of a title field is a convenience difference, not failure of main-text responsibility. Base/link handling is required only to the extent the selected presentation preserves links. |
| Full Miniflux reader/API | Pinned real source screening includes owned entry access, scrape/content processing, sanitizer and feed state. Full reader/API not executed in these extraction packets. | Complementary contender if managed external reader state/subscriptions solve a named requirement. Do not install it merely to obtain a primitive already available without a service. Not labeled an inferior extraction algorithm. |
| FreshRSS | Pinned PHP/DAO/API/feed source screened; full API and extraction fit not run. | Keep interoperability for an existing FreshRSS user/library. No established need for another full reader service for this primitive. AGPL combination scope must be resolved before source adaptation. |
| RSSHub | Actual route/cache/parser source screened, current pin AGPL; no actual route→intake execution here. | Feed generation for a specifically needed non-RSS source, not interchangeable main-article extractor or coordinator. Keep that separate responsibility open. |
| Existing Control Center-based collection / CR summary + source link | Actual integrated discovery/curation and current rendering; strict news wire has no body. | Retain collection and fallback. **Summaries alone do not fulfill the desired full-article reading requirement.** Do not use zero new dependency cost to close that requirement. |

## Evidence and maintenance scope

Readability registry gitHead is `4d5dd0bbe0bfbc44e219dc86865131e79639e30b`; implementation SHA256 `34dcab3d0832d0019f02990eed6b6124e029e8c32b9f0c6f2550544ff8dff174`. jsdom API SHA256 `0653e655065e93d44d885b04a975c0bac3221513bfc7be0be0afd2a4cc99ff2e`. Exact acquisition/integrity closures remain in the existing F7 receipts. Node engine floors reported there fit the current Node22 baseline. These pins define the compared releases, not a fresh claim they are the newest or vulnerability-free.

Readability's documented jsdom example and inspected dual-DOM upstream tests provide a supported embedding path. The bundled parser is a shipped, upstream-tested subpath but not the same top-level typed/documented interface. Miniflux's narrow internal Go package has actual upstream test evidence but no proven stable independent Node distribution interface. That is packaging/maintenance work, not a reason to copy and permanently fork its algorithm.

Readability's selected core is Apache2, jsdom MIT, while bundled JSDOMParser carries MPL2. Miniflux selected root/source Apache2 and inspected external packages BSD-style. Preserve exact notices and F9 dependency/file scope: none of these labels clears transitive licenses, assets, modification notices, or article republication rights. This review gives no legal approval. In particular do not flatten a package's root metadata over a differently licensed bundled file; absence from an executed import path is not itself proof of absence from a shipped archive.

## Resource evidence is not a winner metric

The baseline jsdom process peak was113520KiB versus bundled52800KiB; expanded per-child samples were about104576–105456KiB versus47920–48208KiB. These are cold, small, unrandomized fixture processes including imports/harness; three bundled cases fail early. No production sizing or equal-success throughput inference follows. Miniflux's564168KiB acquisition/toolchain/cache snapshot is **disk**, not deployed-process RSS, so it cannot be compared with either Node peak. No cross-runtime memory winner is established.

For eventual bounded integration, verify acceptable process memory on the intended small host and enforced input/time/output limits; that is deployment fit, not an excuse to call the smaller but mismatching DOM equivalent. The extractor's max-elements check occurs after DOM construction and cannot bound that prior allocation. Both extraction outputs retained onclick; neither is a sanitizer. Optional isProbablyReaderable true/false on two samples is useful evidence of API compatibility, not a broad quality classifier qualification.

## Required adaptation and what is not finished

The actual integration map establishes that current `newsPageSchema` contains summary≤4000 and no body; story digests bind complete unsigned story content; ingestion has stale-observation fences; task actions bind story ID/digest. Source extraction cannot silently rewrite any of those bindings.

`NativeResultStore.capture` requires completed native evidence and is not a pre-task article bucket. Existing byte ports and canonical artifact helpers remain reusable, but concrete native/current storage implementations have65536-byte caps and lineage requirements. Do not fabricate a completed run, silently truncate an article, raise native-result limits incidentally, or create a second generic artifact engine. Root must select the legitimate source/task-bound detail seam and its explicit limits.

Keep retrieval authorization, redirect/base URL handling, untrusted content, source URL/provenance, expiration, stored-byte identity and safe presentation as distinct responsibilities. Plain-text reading is an available lower-complexity option, not a final UI decision. If HTML presentation is selected, use and qualify a maintained sanitizer rather than treating extraction as sanitation.

Before full-reader E3 completion, actual selected output must cross the chosen detail/storage/UI seam; wrong-project and stale-story requests must fail; repeated extraction must not mutate approved task lineage; empty/failed/oversized inputs need disclosed fallback; source text and agent-generated results must remain distinguishable. Article→research/setup-guide/compare/draft actions must retain canonical provenance. Real layout quality, resource limits and publication policy remain explicit qualifications, not implied by eleven synthetic input shapes.

## Narrow closure and removal map

Recommend closing **only the default extractor primitive comparison** with these conditions recorded. Named alternatives have enough comparative implementation evidence or distinct responsibility disposition to avoid another broad search before the integration experiment. No claim to have evaluated every Internet extractor; an additional maintained DOM is optional unless the chosen closure fails a real deployment requirement.

Current product modules removed:0. Future custom main-text scoring/extraction algorithm avoided:yes. Existing collector/parser/source identity/queue/archive/research/review modules retained. Additional custom HTML normalizer, selector engine, general artifact engine and full reader service are not justified by these results. Final adoption, security/schema/UI design, shipping license review and reader completion remain root decisions.
