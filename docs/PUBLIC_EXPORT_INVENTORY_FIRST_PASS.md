# Public export inventory — first pass

2026-09-06; inspected tracked tree at `cd9e2ad`. Private planning document, not an
export allowlist. No files copied or cleared for publication. Counts refer to tracked
paths, not code size, sensitivity or completion. Untracked and ignored files are excluded
from these counts and must never be swept into an export implicitly.

## Structural findings

| Tracked area | Files | Required disposition work |
|---|---:|---|
| `src/` | 622 | Review generic runtime plus embedded fixture/adaptor dependency closure |
| `app/` | 77 | Separate branded/demo routes from generic contributor experience |
| `private-app/` | 28 | Review actual protected application; directory name alone does not make source secret |
| `tests/` | 415 | Preserve useful coverage; replace private-specific inputs and identify external prerequisites |
| `db/` | 68 | Review generic migrations/roles separately from operator-specific scripts |
| `scripts/` | 37 | Classify build/test versus qualification/research/operator execution |
| `docs/` | 896 | Do not export wholesale; write public documentation from verified current behavior |
| `packages/` | 28 | Existing public candidate is narrow and not a full application distribution |
| `coordination/` | 46 | Keep private by default; replace private worker administration with public contribution docs |
| `.github/` | 6 | Review individually; do not inherit private jobber workflows or private CI dependencies |
| `skills/` | 11 | Review rights and assumptions before adapting any worker instructions |
| `third_party/` | 2 | Preserve required license/NOTICE with any included upstream code |
| `public/` | 2 | Review asset ownership, metadata and depiction; not automatically publishable |

Other tracked roots also require disposition, including build configuration, contracts,
schemas, examples, release metadata, worker entrypoint, environment example and internal
agent instructions. This table is an initial prioritization, not an exhaustive manifest.

## Concrete coupling that must be addressed

1. `app/page.tsx` imports fixture projection builders from `src/ready-frontier/v1` and
   renders the dashboard. Its homepage is not evidence of a live database-backed fleet.
2. `app/project-workspace-page.tsx` imports the fixture catalog and specific news/media
   adapters; project lookup uses the fixture catalog. Removing named project directories
   without changing these imports would break the demo.
3. `app/fixtures/project-workspace-ui.ts` imports the central fixture catalog and the
   media adapter. `app/workers/[workerId]/page.tsx` also reads the fixture catalog.
4. `app/api/v1/fixture-snapshot/route.ts` serves fixture data, and the simulation route
   imports simulator scenarios. Review both for retained demo functionality and labeling.
5. Branded IDs also occur in ready-frontier fixtures, review fixtures and simulator data.
   Names-only edits are insufficient: references, digests and expected test results
   may be linked. Preserve private historical evidence instead of rewriting it.
6. The VPS build uses the repository's Vite configuration via `scripts/build-vps.mjs`.
   Copying only the candidate packages cannot reproduce this application build.

## Proposed extraction order

- Trace the protected application entrypoint and build inputs first. Identify which
  source/test/configuration paths are actually required for a runnable generic preview.
- Select a small synthetic demo catalog (for example research, documentation and media)
  with invented identities and no personal history. Preserve the owner's original examples
  privately; avoid rewriting all historical fixtures just to change branding.
- Keep a clear distinction between demo screens and protected operational screens.
  Generalization must not replace implemented database-backed behavior with mock-only UI.
- Build a per-path manifest with `include-after-review`, `adapt`, `exclude` or `unresolved`,
  reason and dependency evidence. No initial category counts as publication clearance.
- Review every included file, transitive dependency, binary asset and generated artifact;
  then rehearse from the assembled isolated tree with no imports from the private checkout.

## Stop conditions for export

Do not export if a required import points outside the candidate, a license/asset right
is unresolved, personal data survives review, or instructions require private paths,
accounts or secrets. Do not remove security enforcement merely to make a demo start.
Do not copy `.git`, ignored runtime files, local databases, credentials, downloaded
evaluation trees or the unrelated poster. A secret scanner complements manual privacy
and provenance review; it cannot certify this tree by itself.

## Next evidence

An exhaustive path disposition and entrypoint dependency map remain to be produced.
This first pass establishes that extraction requires a coherent application slice,
not just a license-file fix or a global project-name replacement. The companion
`PUBLIC_PROJECT_BRIEF_DRAFT.md` is a local draft, not approved public content.
