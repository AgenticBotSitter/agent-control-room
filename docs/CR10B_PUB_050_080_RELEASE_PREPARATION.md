# CR10B-PUB-050/060/070/080 — Local release preparation

**Status:** complete locally as synthetic-only, non-authorizing preparation

## Delivered

- `examples/synthetic/` is a fifth private workspace candidate that runs all three fabricated reference adapters in memory and returns a safe conformance summary.
- `docs/public/` contains tested source-workspace, adapter-authoring, conformance, integration-boundary, and security guides.
- `schemas/public/` contains strict public observation-manifest and disabled release-plan schemas.
- `release/` contains declarative recipe and NOTICE metadata, with no archive, installer, destination, or command.
- `src/public-package/v1/release-tooling.ts` defines the exact nine-step release plan, synthetic reproduction observations, two-run clean-room assessment, and disabled materializer.
- `scripts/public-package-synthetic-clean-room.ts` performs a deterministic in-memory rehearsal and can produce only `synthetic_candidate_only`.

## Reproducibility boundary

The release plan binds package version, source-revision digest, dependency-lock digest, four exact package-tree definitions, ordered step evidence classes, and its own digest. It plans metadata verification only. Archive creation, package installation, registry/network/native-harness contact, signing, upload, publication, and release authority are all false.

Two observations must bind the same plan, use different synthetic runner identities, pass guide and conformance checks, and return the same four output digests. Even then, the assessment records no actual clean-room installation and no actual release artifact. External independent evidence remains required.

`release/public-workspace-v1.json` enumerates the four package candidates and the synthetic example without changing the repository's protected dependency-preparation policy. A package-runner policy check attempted registry metadata lookup despite offline mode; the sandbox denied every request and the command was interrupted. No registry response, dependency download, package installation, archive, or external change occurred.

## Limits

This block does not claim license disposition, complete SBOM, public-tree safety, private-data scan completion, normalized schema/fixture links, vulnerability policy, signature validity, real clean-room installation, certification, or release readiness. Those are CR10C and CR10Q gates.
