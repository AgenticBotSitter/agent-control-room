# F9 entities notice provenance follow-up

2026-09-08. Research only; production notices/package contents unchanged.

The installed `@nodable/entities@3.0.0` omits a root license file but declares MIT.
Exact npm version metadata supplies registry integrity
`sha512-8L9xFeTYKhm49xfIypoe2W5wV1m/3Z58kT+7kR9A8OyFxcPduI4VmxaUMQyKYrRjUoLLSXv6EKKID5Tvj9cUVw==`
and gitHead `d2070d76a8ba07e6c7fa142caeb51ffd756e47eb` in nodable/val-parsers.

At that immutable source pin the root LICENSE is MIT, copyright2026 Nodable.
The package is in `Entity/`, not root or a guessed lowercase entities path.
All seven installed `src` files and README match that source byte-for-byte.
**Manifest differs:** source says2.2.0 while installed/registry say3.0.0;
`diff -u` shows only that version field differs. Do not erase this discrepancy or
claim the source manifest itself identifies release3.0.0. Registry gitHead plus
matching actual code bytes supports the notice provenance more strongly than
current-main license or the manifest's SPDX alone.

The complete upstream license text is preserved in `f9-entities-MIT.txt` and
source hashes/byte comparisons in `f9-entities-source-receipt.json`. These are
research evidence for the later distribution-notice update, not proof the current
binary now contains notices or that the whole dependency graph is cleared.
No package installation, modification, dependency execution or tarball acquisition.

## Acquisition and cleanup

Disk140GiB free before acquisition. Public registry/tree metadata inspected without
retaining responses; root package.json lookup404 identified the need for actual tree
paths. Ten selected source/license files75,459bytes acquired at exact pin through
`research/reuse-comparisons/f9-entities-source-check.mjs`, owned root
`/private/tmp/cr-f9-entities.pXdtu9`, cap300KB. Receipt preserved; allocated100KiB.
No process/service started, and exact-root lsof returned no handles. Exact owned
root was removed and absence verified after receipt/license preservation;100KiB
of disposable sources removed. Source downloads can be reacquired at the recorded
pin. Retained license text SHA256 matches the acquired original exactly.

## Independent source/receipt review

2026-09-08; compare_operations, no download or package execution. Read this report,
source receipt and retained full MIT text; retained text is1064bytes with SHA256
`750cb3fb6362804957ef52caaf9b5c824015be44d494637330d7cd8834d31d40`, matching receipt.
Eight code/type/readme entries record exact local matches; manifest mismatch is
explicitly preserved rather than claiming source version3.0.0. This supports the
scoped upstream notice-location conclusion, not identical whole published archive,
complete license closure or notice installation into a shipped artifact. No new
blocking provenance wording issue found. Registry gitHead and version-only diff
observations are attributed to acquisition evaluator, not independently re-fetched
or re-diffed in this review. Cleanup is now recorded completed by evaluator;
distribution-notice assembly remains separate work as already stated.
