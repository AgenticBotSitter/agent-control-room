# Four existing runtime notice exceptions revalidated

2026-09-08; baseline4d204e6. Read-only current-package checks; no downloads,
candidate installation, application modifications or release generation.

The prepared pnpm graph's four missing conventional root-text cases already have
retained notice sources. Revalidating those sources avoids confusing a filename
scanner's omission with a newly missing license or repeating upstream research.

| Exact installed identity | Existing retained source | Current verification |
|---|---|---|
| pg-types2.2.0 | Full MIT section in installed README, retained in embedded-runtime-notice-texts.json | Full README hash, manifest hash, section bytes and section hash match |
| pgpass1.0.5 | Full MIT section in installed README, same retained artifact | Full README hash, manifest hash, section bytes and section hash match |
| postgres3.4.7 |1212-byte upstream UNLICENSE at9b92b65da6a5121545581a6dd5de859c2a70177f | Installed version and retained text hash/size match; whole installed package correspondence to upstream source remains unproven here |
| @nodable/entities3.0.0 |1064-byte MIT text atd2070d76a8ba07e6c7fa142caeb51ffd756e47eb | Eight installed code/type/README files match retained source hashes; license text hash/size match |

The entities source manifest said2.2.0 while the installed/registry package says3.0.0.
The prior version-only discrepancy remains explicit. This check revalidates installed
code against the retained receipt; it does not reacquire or independently reproduce
that prior source-manifest diff. Neither a matching text checksum nor a declared SPDX
label is proof of complete package/distribution licensing.

The check uses only the four named entries from the actual prepared pnpm output,
translates its recorded node_modules suffix into this checkout and asserts installed
manifest name/version and realpath beneath the current node_modules directory. It
does not discover or walk a replacement graph. No dependency code is imported.

Use these named texts as explicit packaging inputs with original location and hashes,
not as permission to mutate installed packages or generalize filename exceptions.
Actual maintained-gatherer collection and complete runtime/bundle/copied attribution
remain separately tracked. No whole-RC10 closure or distribution clearance follows.

Reproduce: `node research/reuse-comparisons/f9-runtime-exceptions-check.mjs`.
Four checks passed, exit0. Independent review reran the read-only check successfully
and accepted the narrow evidence. Its nonblocking suggestion to assert the exact
unique four-package result set was incorporated; root rerun produced identical
output. [Receipt](f9-runtime-exceptions-evidence.json),
[review](f9-runtime-exceptions-review.md).
