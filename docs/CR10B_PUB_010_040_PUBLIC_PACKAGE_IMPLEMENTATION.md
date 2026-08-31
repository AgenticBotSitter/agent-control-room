# CR10B-PUB-010/020/030/040 — Local public package implementation

**Status:** complete locally; not released

## Delivered package candidates

- `packages/control-room-core/` supplies the small public observation schema, canonical digest helper, sensitive-value rejection, and immutable data helper.
- `packages/control-room-adapter-sdk/` exposes only compatibility evaluation and observation normalization. Its shape rejects any added method.
- `packages/control-room-conformance-kit/` evaluates supplied in-memory fixtures and returns a deterministic report.
- `packages/reference-adapters/` contains three fabricated reference adapters: Hermes-shaped, Codex-shaped, and a generic example.

All four package manifests are private local candidates with one export each. They use the exact roots frozen by PUB-000. Their source contains no import of the private application runtime and no filesystem, process, HTTP, network, environment, registry, or publish client.

## Boundary decisions

The public contract is deliberately narrower than the private harness contract. It contains no operation, approval, access, scheduling, lease, dispatch, publication, provider, or lifecycle-control method. Adapter manifests declare only `effectAuthority: "none"` and `accessMode: "none"`; the reference adapters accept only fabricated frames and never locate or contact an installed harness.

The root TypeScript configuration maps the four local package names for repository type checking. This is development wiring only, not a package installation, archive, release build, registry contact, signing action, or release claim.

## Acceptance evidence

`tests/public-package-implementation.test.ts` verifies the exact four roots, local-candidate manifests, narrow exports, dependency allowlists, source-boundary scan, public-core rejection behavior, SDK shape rejection, and synthetic conformance.

The focused public-package suite reports 27 passing checks when combined with PUB-000. The completion gate remains limited to local source candidates. It does not establish clean-room installability, reproducible release output, license disposition, SBOM completeness, public-data scan completion, signature validity, or publication readiness.
