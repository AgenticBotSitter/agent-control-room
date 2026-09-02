# CR13A-LIVE-030 independent read-only review

**Disposition:** accepted
**Immutable base:** `ad0e3aee3f28516430bf256204b808496d37b6bc`
**Immutable product target:** `0bbe4e52602f8859b78ca6516377bdbe3ee3378a`
**Reviewer:** different independent Codex reviewer; report only, zero repair budget
**Review packet:** `CR13A_LIVE_030_ENROLLMENT_INTAKE_REVIEW_PACKET.md`

## Findings

No High, Medium, or Low code findings.

## Evidence reviewed

- Active database-key lookup, state/validity checks, and Ed25519 verification:
  `src/connection-registry/v1/intake.ts:243-258,407-418,473-492`.
- Exact replay before later key-state enforcement: `src/connection-registry/v1/intake.ts:449-470`.
- One outer transaction around registry persistence, audit insertion, and head update:
  `src/connection-registry/v1/intake.ts:445-562`.
- Safe digest-only, negative-authority receipt: `src/connection-registry/v1/intake.ts:511-526`.
- Tenant serialization, complete intake-chain verification, and authenticated head consistency:
  `src/connection-registry/v1/intake.ts:379-405,445-449`.
- Database bounds, uniqueness, foreign keys, and append-only update/delete/truncate guards:
  `db/migrations/0035_cr13a_connection_enrollment_intake.sql:3-59`.
- Disabled local source and omission from app-facing runtime ports: `src/local-pilot/v1/runtime.ts:261-268` and
  `app/control-room-local-pilot-runtime.ts:7-44`.
- Existing registry transaction nesting, append-only chain verification, replay rules, and enrollment constraints were
  followed through.
- Product diff and relevant acceptance, build, and decision documentation were inspected. The later checkout commit
  changes documentation only; there is no non-document delta from the product target.

## Commands and outcomes

- `pnpm check`: pass.
- `pnpm lint`: pass.
- Focused intake test: 6/6 pass.
- `pnpm test:cr13a-connections`: 21/21 pass.
- `pnpm test:cr13a`: 37/37 pass.
- `pnpm db:verify`: the first sandboxed run could not create the local `tsx` IPC socket; the authorized identical rerun
  passed migrations `0001` through `0035` and verified 117 PostgreSQL tables.
- `pnpm test:build`: production build and 4/4 rendered-route checks pass.
- Exact product `git diff --check`: pass.
- Final shared working tree: clean on `codex/cr13a-live-030-enrollment-intake` at report-only documentation commit
  `422fd7b`.

## Unobserved and excluded

- No reviewer-owned custom test or probe was created.
- The reviewer did not rerun the full `pnpm test` lifecycle or platform stage zero; the producer's recorded lifecycle and
  ordinary GitHub CI cover those commands.
- GitHub/CI metadata was not queried by the reviewer because its route was network-disabled.
- No networked or production PostgreSQL, credentials, Hermes, SSH, native runtime, provider, deployment, persistent
  server, or external service was exercised.
- Actual networked PostgreSQL concurrency was not tested; existing PGlite concurrency and rollback tests were used.

## Review-attempt record

Two earlier reviewer dispatch attempts were stopped by an automated safety filter before returning any product review
evidence. They made no repository or GitHub changes and count as neither acceptance nor rejection. This report records
the first completed different-party disposition for the immutable product target.
