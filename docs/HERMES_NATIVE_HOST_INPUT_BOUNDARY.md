# Hermes native host input boundary

The local Hermes host now has an inert consistency check joining the existing
release sidecar contract, runtime image inventory, and import policy. It pins
the same release, architecture, image bytes, inventory and fixed ACRHCP1
protocol. Changed image observations or mismatched inputs refuse the join.

`prepareMacosHermesNativeHostInputContractV1` accepts no executable, runtime,
profile, model, environment, argument or working-directory setting. It reuses
the existing inventory verifier and contract parsers. It does not enumerate
files, capture an image, package or compile anything, read credentials, modify
Hermes, or start a process.

The output is a planning record, not a native capability. Even matching supplied
observations do not prove a read-only mounted image or trusted release custody.
The record explicitly remains blocked: the pinned Hermes source is incompatible
with the current import policy, and the real native host and protected release
binding remain unfinished. Future native implementation must obtain filesystem
observations from its own verified read-only image and bind protected installed
state before any execution. This helper cannot substitute for that verification.

Focused verification:
`node --import tsx --test tests/macos-hermes-native-host-input-contract.test.ts`
