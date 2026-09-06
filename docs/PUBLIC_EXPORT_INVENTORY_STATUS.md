# Complete tracked-path planning inventory

2026-09-06. Baseline `91c6dbe`. Local/private planning evidence only.

`research/public-export-inventory.json` records all **2,292 tracked paths** at this
baseline, with a SHA-256 of each regular file's working-tree bytes, a proposed action
and reason. All content reviews remain pending; publicationApproved is false.

| Proposed action | Count | Meaning |
|---|---:|---|
| Review | 796 | Application/build dependency or supporting test/schema/attribution material |
| Adapt | 9 | Root configuration needs a public build/test scope |
| Exclude | 961 | Internal/history/configuration material excluded by default, not deleted |
| Unresolved | 526 | Scope decision still required |

This is the complete tracked-path checklist, not 2,292 completed reviews. Paths added
after this baseline are not covered. Untracked/ignored files, including the owner's
poster, are intentionally outside the report. Do not publish the report: it lists
internal filenames. New report/tool/docs added in this batch are private audit outputs.

The read-only script `scripts/research/public-export-inventory.mjs` regenerates JSON
on stdout from tracked working-tree files. It never copies files, changes visibility,
deletes data, installs packages or grants publication authority. Its own generated report
is excluded from future inputs to avoid a self-referential hash. Regeneration updates
the proposed checklist, not an approved allowlist.

## Expanded dependency evidence

The static traversal now seeds all declared VPS server entrypoints, all protected
application TS/TSX files, the standalone configuration, builder and launcher. It reaches
294 tracked paths. Three launcher imports point to generated `dist-vps` outputs and
remain explicitly unresolved as tracked source, not silently omitted. Two nonliteral
imports require manual review: PGlite loading and the trusted operator configuration.
Runtime SQL/file reads, CSS dependencies, framework discovery and declaration-only
type imports still require separate inspection. Entry seeds are explicit and must be
updated when build entrypoints change; this script is not a bundler or release engine.

## Validation performed

- Every tracked baseline path appears exactly once, in sorted order.
- Every recorded regular-file hash matches the observed file bytes.
- Action counts sum to the tracked-path count.
- Two executions produce identical parsed reports for unchanged inputs.
- Hosting metadata is proposed excluded; standalone build config is pending review.
- All currently unresolved static paths are expected generated build outputs.
- Targeted lint passes. No application runtime changed and no full suite was rerun.

## Next

### Content review batch 01

`research/public-source-content-review-01.json` records a full-text primary-assistant
review of eight generic project UI/entrypoint/build files at `cdad5eb`, bound to their
current content hashes. No embedded personal project data, credential values or private
infrastructure locators were observed in those exact files. This is not independent
review, a complete security audit, or clearance of imported dependencies/artwork.

The observations are separate from the historical all-pending inventory: neither
record is silently rewritten. Changed bytes invalidate the corresponding observation.
Original-code rights, dependency/asset review, final candidate review and owner
publication remain outstanding. No reviewed source was copied or published.

Review unresolved paths by dependency/use, not alphabetical busywork. Start with runtime
filesystem/SQL requirements and contributor test preparation, then assets/licenses and
the shared stylesheet. Convert only reviewed exact files into an explicit candidate
allowlist under the successor public-source policy. The pending checklist does not
authorize copying or supersede the earlier public package restrictions.
