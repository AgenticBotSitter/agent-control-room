# CR12B-IDEA-105 Hermes 0.21 reviewed-runtime pin refresh acceptance

**Status:** Complete for the repository-only pin and source-preflight binding. No native attempt or provider call occurred.

## Accepted refresh

Idea Lab now distinguishes the upstream `0.21.0` release commit from the exact installed runtime reviewed on this Mac:

- release revision: `29112bef099274229cadff79cdff7bf7b99c4b77`;
- reviewed runtime revision: `a2907a8bcdd8e5cdfbd9d6f7ec8b064ce7e40b5b`;
- exact reviewed distance: 60 commits after the release, with the release proven as an ancestor;
- compatibility implementation: `c71de92dbce49ec1b8ae2af7977384c535d265fd` from PR #180;
- reviewed source manifest: `sha256:b51353b3b124995f7de2984df076dc069c846dea4ddcdb987e77d1538df4542f`; and
- sanitized source preflight: `sha256:2cce7c96ebf10532a83418ed199be2edb4cc2ca763e9277f91b9c2c9235b55ed`.

The preflight proved the official origin, exact revision and lineage, clean trusted runtime paths, twelve exact source
hashes, the required lifecycle/replay/control surface, a valid static zero-tool selection, and the pinned MCP/plugin
startup boundary. It counted one unrelated tracked metadata change without retaining its path. It made zero native
attempts, zero provider calls, and accessed no protected value. The missing filtered Bot Mode profile read remains a
separate TEAM-060 blocker and is not misrepresented as Idea Lab lifecycle incompatibility.

The panel packet, qualification plan, owner-ready packet, synthetic live evidence, and candidate schema now bind the
reviewed runtime instead of the older release commit. Their digests therefore changed. The earlier owner authorization
was scoped to the superseded packet and is explicitly non-reusable. A future native attempt requires PR #180 and this
refresh to be integrated, a fresh exact authorization, and an attached Terminal command run by the owner.

## Verification

- Combined CR12B suite: 89/89 passed.
- TypeScript verification passed.
- The pin assertions cover release/runtime separation, the exact 60-commit distance, source-manifest and preflight
  digests, zero-effect preflight truth, and non-reuse of the previous authorization.

## Effects not performed

No Hermes process, profile, workspace, provider, protected value, Keychain, network, repository-external write,
production database/VPS, deployment, DNS, or hosting effect occurred. No native candidate or live-panel authority was
created.

## Next gate

IDEA-110 remains owner-attended. Before asking the owner to run anything, integrate the exact compatibility and packet
commits and complete a no-effect readiness check. Then use `CR12B_IDEA_105_OWNER_AUTHORIZATION.md`; do not reuse the
IDEA-100 authorization. A successful result remains an unaccepted candidate and cannot start a live panel.
