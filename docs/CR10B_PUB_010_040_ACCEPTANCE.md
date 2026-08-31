# CR10B-PUB-010/020/030/040 acceptance

This block is accepted locally only when all of the following hold:

- Four exact package roots exist and match the frozen PUB-000 classification roots.
- Each package is a private local candidate with one source export and no release scripts, binary, or publish configuration.
- Public source imports only declared public package dependencies and contains no private runtime or effect-capable client.
- The adapter SDK permits only observation compatibility and normalization, and rejects extra callable surface.
- The conformance kit uses supplied fixtures only.
- Hermes-shaped, Codex-shaped, and example adapters pass as synthetic-only examples.
- `pnpm test:cr10b`, type check, lint, production build, rendered route test, migration verification, and diff validation pass.

Passing this block does **not** authorize a package build, release, install, signature, registry contact, external harness interaction, deployment, provider action, or repository-visibility change.

## Local verification recorded

- `pnpm test:cr10b`: 27 passed, 0 failed.
- `pnpm check`: passed.
- `pnpm lint`: passed.
- `pnpm test`: 414 passed, 0 failed, 2 intentional platform skips.
- `pnpm test:build`: production build plus 2 rendered-route checks passed.
- `pnpm db:verify`: 96 PostgreSQL tables verified through migration 0026.
