# Notice attribution: evidence for the dependency closure

2026-09-12. Evidence only. This does not close `notice_attribution_review`, does
not certify anything, and is not release authority. The public tree disposition
remains `blocked_before_independent_review`.

## What was checked

The production dependency closure of both repositories, resolved the way Node
resolves: up from each dependent's realpath, not by scanning the top level of
`node_modules`. Both resolve to the same 38 packages, so findings apply
identically to the public tree.

Tool: `scripts/research/production-license-inventory.mjs`, output
`docs/research/production-license-inventory.json`.

## Findings

| Package | License | Finding |
|---|---|---|
| `@nodable/entities@3.0.0` | MIT | Ships no license text. Tarball contains only `src` and `README.md`; the README names MIT without reproducing it. **Gap: MIT requires retaining a copyright notice and none existed in the tree.** |
| `postgres@3.4.7` | Unlicense | Ships no license text anywhere. Public-domain dedication, so no attribution is required. Noted, not blocking. |
| `pg-types@2.2.0` | MIT | Full text and copyright present, in the README rather than a license file. Retainable as-is. |
| `pgpass@1.0.5` | MIT | Same. |

The last two were initially reported as gaps. They are not: the text exists, it
is simply not in a file named `LICENSE`. The first version of the inventory
looked only for that filename, and calling those packages a gap was wrong.

## Resolution

Both missing texts were sourced from the packages' own upstream repositories and
retained in the public repository under `third_party/`, matching the existing
`control-center` and `rss-parser` layout. See
`AgenticBotSitter/agent-control-room` PR #16.

The retained `@nodable/entities` license hashes to the upstream blob recorded in
its notice (`561468f111a66df52cc0f1934642bb9fdd22a212`), so the provenance claim
is verifiable with `git hash-object` rather than taken on trust.

## Supply-chain check performed in passing

`fast-xml-parser@5` introduces several small packages whose names give no obvious
connection to it: `@nodable/entities`, `fast-xml-builder`, `is-unsafe`,
`path-expression-matcher`, `xml-naming`, `anynum`, `strnum`. That is the shape of
a dependency-injection attack, so it was checked.

All seven are published to npm by `amitgupta`, the account publishing
`fast-xml-parser` since 2017. The remaining two transitive packages, `non-error`
and `tagged-tag`, are published by `sindresorhus`. The manifest `author` field is
self-asserted and proves nothing; the registry publisher is what was checked.
Conclusion: legitimate modularisation by the maintainer, not injection.

## Deliberately out of scope

The closure including development dependencies is 417 packages, of which 20 state
a license and ship no text. None are distributed by the public source preview, so
no notice was retained for them. Two matter before any compiled artifact ships:

- `@resvg/resvg-wasm@2.4.0` is **MPL-2.0** and ships a compiled `.wasm` payload.
  MPL carries source-availability obligations, not merely notice retention. It is
  a transitive development dependency, listed in neither `dependencies` nor
  `devDependencies` directly.
- `workerd` and `@humanfs/types` are Apache-2.0, whose section 4(d) governs NOTICE
  retention, and neither ships one.

Whoever prepares the first compiled release must re-run the inventory against that
artifact's actual contents, not against a source list.

## What remains open

`notice_attribution_review` is not satisfied by this document. This supplies the
dependency-side evidence an independent reviewer would need; the review itself has
not happened, and the implementer must not be the one to approve it.
