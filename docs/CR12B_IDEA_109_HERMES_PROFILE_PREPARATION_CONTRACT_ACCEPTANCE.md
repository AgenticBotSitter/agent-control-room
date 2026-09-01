# CR12B-IDEA-109 Hermes-native profile preparation contract acceptance

**Status:** Complete for the effect-free, proposal-only contract. No Hermes runtime revision or native method is accepted.

## Accepted contract

Control Room now defines the narrow upstream operation needed to unblock IDEA-110:
`profiles.prepare_control_room_qualification`.

The operation must stay inside Hermes custody and:

- transfer existing protected authentication internally into a temporary qualification profile;
- copy no SOUL, memory, skills, plugins, MCP configuration, rules, or sessions;
- return no protected-value material and no native path;
- start no gateway and contact no provider;
- issue an opaque one-use launch permit that remains in Hermes-native custody;
- return only signed digests, negative context counts, expiry, and device attestation; and
- provide a separate cleanup method.

The Control Room manifest has an empty accepted-runtime list. Even ideal injected compatibility evidence therefore returns
`runtime_revision_not_accepted`. The request builder creates only a digest-bound, maximum-60-second proposal tied to the
exact reviewed runtime and owner packet. It performs zero native/provider calls, accesses no protected value, and grants
no command or execution authority.

## Verification

- New focused suite: 5/5 passed.
- Combined CR12B suite: 98/98 passed.
- TypeScript and full lint pass.
- Tests cover the ideal-but-unaccepted path, every private-context/custody/gateway/provider/cleanup incompatibility,
  short expiry, policy tampering, accessors, Proxies, and absence of native/filesystem/network/provider clients.

## Effects not performed

No Hermes checkout was modified. No profile, protected value, native process, provider, gateway, filesystem path,
network, deployment, production database/VPS, or live panel was contacted or changed.

## Next gate

The method must be implemented in Hermes, reviewed at an exact source revision, and added to the compatibility source
manifest. A signed native attestation verifier and cleanup/one-use consumption contract must then be integrated and
independently reviewed. Only after another packet refresh may the owner receive new exact authorization text.
