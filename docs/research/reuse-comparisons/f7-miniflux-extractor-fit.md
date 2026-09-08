# Actual Miniflux pure extractor comparison

2026-09-08. Pin `a84533db6ca0a2ff9a47800fbf0326be6d9b3170`.

**The small unchanged Miniflux extractor works independently of the Miniflux service.**
Its 230 upstream inline tests passed, and it processed the same six synthetic inputs
as the Mozilla experiment. This is E2 actual-package evidence, not a production
adapter or whole-service qualification. The earlier source report remains the E1
record; this report advances it rather than replacing it.

## Exact execution and provenance

Command: `node research/reuse-comparisons/f7-miniflux-extractor-execute.mjs`.
Terminal session21659 completed exit0, all seven subprocesses exit0. The retained
runtime evidence records exact commands, stdout/stderr/status, source acquisition
hashes in the companion acquisition ledger, Go checksums, package download receipts,
and full raw extractor outputs. No focused repair or candidate retry was needed.

Official Go1.26.0 darwin/arm64 archive was checked against its official download
index SHA256 `b1640525dfe68f066d56f200bef7bf4dce955a1a893bd061de6754c211431023`.
The disposable module kept `miniflux.app/v2` and copied unchanged readability.go,
readability_test.go and urllib/url.go after checking all retained source hashes.
Only the authored JSON stdin/stdout runner and minimal go.mod were added. Pins:
goquery1.12.0, x/net0.58.0, cascadia1.3.3. The corpus was read directly as JSON with
no HTML normalization; SHA256
`4f7f0d52d377129144bcd2674c718f9ad5d8b77e1c165d7b804013e3cb172f6a`.

`go test -p 1 -parallel 1 -timeout 90s -json ./internal/reader/readability`
passed230 named tests. Benchmarks and their unhydrated HTML testdata did not run.
`go build -p 1` succeeded. Each subprocess had a120-second outer timeout, capped
output and GOMAXPROCS2/CGO disabled. These are harness resource bounds, not measured
production latency or memory guarantees.

## Same six inputs, unchanged native interface

| Shared case | Actual outcome | Meaning |
|---|---|---|
| Article with relative link | Both main markers retained; href remains `../guide`; baseURL empty; no title field | Core extraction works. Title and page-relative URL resolution require a separate caller/adapter step, unlike Mozilla's richer result. |
| Navigation and scripts | Main markers retained; nav/footer markers and script tags absent; `onclick` retained | Useful content extraction, **not sanitization**. No JavaScript engine or fetch is invoked by this pure Go path; no network-denial instrumentation was performed. |
| Empty page | Success with `<div><div></div></div>` | No native null/no-article result. Caller would need an explicit empty-content policy; none was fabricated here. |
| Navigation only | Success with Home/About navigation HTML | Negative evidence: no reliable no-article result on this fixture, as also seen with Mozilla. |
| Oversized bytes | Runner rejects before native call | Shared caller byte policy works; not a Miniflux feature. |
| Oversized elements | Extractor returns article HTML | No native max-elements option. The fixture did not pretend its ignored option was a pass. |

A headline pass fraction would conflate extraction quality and interface features,
so no six-case quality score is claimed. The raw outputs preserve all differences.
Neither extractor should render untrusted HTML without a separately reviewed
sanitization and network/resource boundary.

## Actual minimum graph and integration cost

`go list -deps .` confirmed only four nonstdlib external package imports:
x/net/html, x/net/html/atom, cascadia, goquery. No PostgreSQL, Miniflux fetcher,
configuration, server, user store or feed synchronization package is linked.
The Go stdlib graph includes net/http via goquery; that import does not mean this
runner fetches pages. `go mod download all` acquired a broader module graph, including
unused testing/tool dependencies: those are recorded acquisitions, **not** the binary's
actual import requirements. Do not substitute download breadth for runtime graph.

Unchanged upstream source is17,012bytes plus the authored31-line runner. A practical
Node integration would additionally require binary distribution for supported hosts,
bounded child-process I/O and failure/cancellation handling, title/base/link adaptation,
empty-content policy and independently reviewed HTML handling. None is implemented.
No full Miniflux service/database is necessary for this option.

The current Control Room article UI is summary plus canonical link, and its strict
news wire has no article-body contract. Therefore this option currently deletes
**zero** existing production modules; it can replace a future custom extraction
algorithm, not the current collector or research-task authority. The shared-corpus
Mozilla alternative supplies more of the desired metadata/URL/element-limit interface
inside JavaScript, while this Go option is demonstrably small and service-free.
Root should compare these concrete adaptation costs, not reject Miniflux merely
because its full application is large. Final selection remains with root.

Judgment ratings (0–5, higher is better, no weighted total): pure extraction fit3–4;
Node integration ease2–3; avoidance of custom extraction algorithm4; exact current
code-removal benefit0. Broader publisher quality, production memory/latency,
maintenance effort and packaging cost remain unknown rather than scored zero.

## Licensing, storage and limitations

Pinned Miniflux LICENSE is Apache2.0. Actual selected goquery/cascadia/x-net license
files were inspected and retained as text+hash in the receipt (BSD-style redistribution
conditions). This is not whole dependency-graph legal clearance; the Go distribution
and broader downloaded modules require their own notices if redistributed.

Toolchain/source/dependency/cache/binary total564,168KiB at final measurement, below
4GiB; free space remained above20GiB.375 download-cache file entries are hashed,
with `go mod download -json all` and go.sum preserving module versions/content sums.
No global installation, application package/lock changes, service or credentials.

Acquisition harness caveat: fetch used full-buffer length checking without an
explicit download deadline, **not** streaming enforcement of a memory cap. It
completed successfully; no rerun was needed. Future acquisitions must add bounded
streaming and an AbortSignal deadline. The harness also assigned its disposable
HOME environment entry; future fixtures should leave that system variable alone
and use only dedicated Go cache/workspace variables. No ambient profile was copied.

Cleanup: initial removal encountered Go module-cache read-only directories and
returned exit1. Only the owned cache received `chmod -R u+w`; exact owned-root
removal then succeeded and `test ! -e` returned exit0. Toolchain, candidate source,
module caches and binary were removed; sanitized reports, acquisition receipts and
authored reproduction fixtures remain. No persistent resources were created.
