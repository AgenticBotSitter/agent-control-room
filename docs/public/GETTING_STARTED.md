# Getting started with the local public candidates

## Scope

The current `0.1.x` source candidates support observation contracts, adapter normalization, synthetic conformance, and fabricated examples only. They cannot operate a harness, obtain access, schedule work, publish a package, or deploy Control Room.

## Requirements

- Node.js 22.13.0 or newer.
- pnpm 11.19.0.
- A local checkout containing only the explicitly classified candidate roots.

## Verify the source workspace

From the repository root, run the stage-zero check first, then the focused public-package tests, type check, and lint. These checks use the existing local dependency preparation; they do not prove a clean-room installation or released-package behavior.

## Run the fabricated example

Use the synthetic example only through its exported `runSyntheticControlRoomExampleV1` function. A passing result means the in-memory fixtures conform to the local observation boundary. It does not mean Hermes, Codex, a provider, or an external service was found or contacted.

## Stop conditions

Stop before an archive, package installation, registry request, key use, signature, upload, native harness call, or external service call. Those activities require later independent evidence and owner authorization.

## Next guides

- [Author an observation adapter](HARNESS_ADAPTER.md)
- [Run conformance](CONFORMANCE.md)
- [Understand project, executor, provider, and node boundaries](INTEGRATION_BOUNDARIES.md)
- [Review the security boundary](SECURITY.md)
