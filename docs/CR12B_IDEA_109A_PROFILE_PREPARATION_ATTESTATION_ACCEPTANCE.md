# CR12B-IDEA-109A signed profile-preparation attestation acceptance

**Status:** Complete for injected signed evidence only. The runtime remains unaccepted and launch eligibility is false.

## Accepted verifier

Control Room can now verify the future Hermes-native profile preparation without receiving protected material, native
paths, or a reusable launch handle. The verifier requires:

- a canonical Ed25519 device key that exactly matches the separately trusted key ID and SPKI;
- a signature over the complete canonical body plus an independently verified body digest;
- exact request and reviewed-runtime binding;
- preparation, issue, evaluation, and expiry chronology within both the 60-second request and attestation windows;
- distinct profile identity, native-held launch-permit, and protected-value-custody evidence digests;
- explicit zero counts for SOUL, memory, skills, plugins, MCP configuration, rules, and sessions;
- no returned protected material or native path, no gateway start, no provider call, and a cleanup method; and
- strict ordinary-data boundaries that reject accessors and Proxies before behavior runs.

The sanitized result omits the signature and public key, retains only bounded digests and zero counts, and fixes
`acceptedRuntimeImplementation`, `launchEligible`, native qualification, approval, command authority, and execution
authority to false. Ideal signed repository fixtures remain blocked by `runtime_implementation_not_accepted`.

## Verification

- New focused suite: 5/5 passed.
- Combined CR12B suite: 103/103 passed.
- TypeScript and full lint pass.
- Tests cover canonical signature/key proof, key substitution, request/runtime/chronology/expiry drift, nonzero context,
  returned material/path, gateway/provider activity, missing cleanup, re-digested authority, and Proxy input.

## Effects not performed

No device key was enrolled. Test keys are ephemeral fixtures. No Hermes checkout, profile, protected value, gateway,
provider, native process, filesystem, network, deployment, production database/VPS, or live panel was contacted.

## Next gate

Implement the frozen method in Hermes and review its exact source. Then add a durable broker-private one-use permit
registry that binds preparation, launch, cleanup, and terminal ambiguity before any runtime revision can be accepted.
