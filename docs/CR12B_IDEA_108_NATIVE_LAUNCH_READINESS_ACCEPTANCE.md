# CR12B-IDEA-108 native-launch readiness acceptance

**Status:** Complete with a blocked-before-owner-command disposition. No native attempt or provider call occurred.

## Real blocker found

The refreshed owner packet requires a disposable empty Hermes profile while using the owner's existing Hermes
authentication. Exact source inspection of the reviewed Hermes runtime shows those requirements do not currently join:

- a fresh `--no-skills` profile seeds an empty protected-value file;
- the clone path copies the protected-value file, but also copies `SOUL.md`, installed skills, and selected memory files;
- Hermes rejects combining `--no-skills` with clone or clone-from; and
- Hermes has no protected-value-only clone operation.

The exact reviewed sources are bound as:

- `hermes_cli/profiles.py`: `sha256:edeafa558cea28cc42ce4e80a21489a3176454a48bae9f767d8c179b954e0981`;
- `hermes_cli/subcommands/profile.py`: `sha256:b82d2a1d6ed164203b33897aa3aec3797c7f80bfda93ad066e49d8ec904e8196`.

Control Room therefore emits no owner command. It does not silently copy a private bot persona, memories, skills, or
rules into the qualification profile, and it does not weaken the empty-profile boundary to use the default live profile.
The strict digest-bound readiness result fixes profile eligibility and all authority fields to false and records zero
attempts, calls, or protected-value access.

## Verification

- New hostile readiness suite: 4/4 passed.
- Combined CR12B suite: 93/93 passed.
- TypeScript, full lint, and whitespace validation passed.
- Tests cover the exact profile semantics, re-digested eligibility/command/authority/source claims, accessors, Proxies,
  and absence of process, filesystem, network, protected-value, or provider clients.

## Safe remediation choices

One separately reviewed change is required before IDEA-110:

1. Hermes adds and Control Room pins a native protected-value-only disposable-profile preparation operation that copies
   no SOUL, memory, skills, plugins, MCP, rules, sessions, or other bot context; or
2. the owner explicitly authorizes a revised, exact Hermes-native clone-and-sanitize procedure after its source,
   pre-provider cleanup ordering, negative context proof, and rollback behavior are implemented and independently
   reviewed.

Neither choice is made by this block. A source change invalidates the current runtime/source pins; a scope change
invalidates the current owner packet. In either case a new exact authorization is required after integration.

## Effects not performed

No Hermes command, profile create/clone/delete, native process, provider call, protected-value access, Keychain access,
network request, deployment, production database/VPS contact, or live panel occurred.
