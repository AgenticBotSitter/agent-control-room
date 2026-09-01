# CR12B-IDEA-110F — independent macOS connector review packet

## Frozen target

- Product commit: `70f5890b3be5162896a585dae458a9a9c02e8036`.
- Accepted fixed-bridge implementation: `2bc80a20c7e4e1753b014395866972622c134fd3`.
- Accepted fixed-bridge report SHA-256:
  `6ed834e8b5c3418bc0bc932e56ae991a9c33f4699b81860f78be194a34a5b9c8`.
- Runtime revision: `a2907a8bcdd8e5cdfbd9d6f7ec8b064ce7e40b5b`.
- Review mode: report only, zero repair, zero native or external effects.

The reviewer must be different from every IDEA-110F contributor and from the three prior bridge reviewers. Producer tests
are inputs, not acceptance evidence. Acceptance covers only this unconfigured provider-disabled connector candidate.

## Required attacks

### Exact host boundary

- Put enumerable getters independently on every open, operation, close, parameters, collector, and private-port field.
- Repeat with setters, non-enumerable fields, unknown fields, symbols, inherited fields, null prototypes, subclasses,
  callable Proxies, object Proxies, nested Proxies, and post-construction prototype or descriptor mutation.
- Prove rejection executes zero caller behavior and makes zero private-port calls.
- Use concrete private-field private-port methods and prove their original receiver survives open, request, and close.

### Route and authority binding

- Drift each connection, transport, route, attempt, permit, lease, profile, conversation, source-manifest, runtime, and
  operation binding independently before private dispatch.
- Try omitted, duplicated, aliased, malformed, overlong, re-digested, expired-looking, and cross-attempt values.
- Prove local and SSH modes never introduce a host, user, port, key, path, gateway, protected value, profile locator,
  native session identifier, shell, or arbitrary method into Control Room input, output, state, source, or errors.

### Lifecycle and concurrency

- Attempt every operation before open, duplicate open, every ordinary permutation, skipped and repeated steps, early
  cleanup, ordinary work after cleanup starts, duplicate close, and every call after close.
- Pause open and each operation. Race caller abort, route close, duplicate request, and late private-port return at every
  await. Prove close aborts and waits for settlement and never reports cleanup while an earlier call can still dispatch.
- Prove an uncertain open is close-only and never retried. Prove an uncertain operation is cleanup-only and never retried.
- Prove a successfully returned create cannot bypass at least one native cleanup attempt before route close. Exercise
  interrupt, cleanup status, session close, and route-close failure or malformed receipts independently.
- Confirm all terminal and ambiguous paths remain one attempt with zero automatic retry.

### Receipt sanitation

- Add each locator-shaped, credential-shaped, secret-shaped, native-identifier, raw-content, extra, unknown, inherited,
  symbol, accessor, Proxy, oversized, malformed, and wrong-binding field to route-open, operation, event, and close results.
- Mutate retained result objects before return, in a queued microtask, and after collector submission.
- Prove the connector returns only exact safe top-level receipts; the fixed bridge rejects nested event and semantic drift;
  and no hostile getter or Proxy trap executes.
- Prove successful route close requires close, lease release, disposable profile/workspace removal, and zero retained native
  references, with exact attempt, permit, and route binding.

### Composition and upgrade boundary

- Confirm the shipped disabled record has no configured port, signer, route, connection, native attempt, SSH connection,
  provider call, live-panel eligibility, or execution authority.
- Search production source and composition for process, filesystem, socket, fetch, SSH, credential-store, Keychain,
  protected-value, signer, environment, gateway, provider, deployment, and generic-shell clients.
- Confirm the connector does not modify Hermes and does not claim compatibility beyond the pinned 0.21 source manifest.
- Confirm any connector, private-port, source-manifest, runtime, signer, or route change invalidates later evidence.

## Required verification

```text
node scripts/qualification/platform-key-store-stage-zero.mjs --platform <reviewer-platform>
npm run check
npm run lint
npm run test:cr12b
npm test
CI=true npm run test:build
npm run db:verify
git diff --check <review-integration-base>...HEAD
```

If the prepared checkout is not stage-zero ready, stop without installing or repairing anything. No Hermes/native/SSH,
credential, protected-value, provider, production database, deployment, DNS, hosting, or other external effect is
authorized.

## Disposition

The only dispositions are `accepted_provider_disabled_snapshot`, `remediation_required`, or
`blocked_incomplete_review`. Every finding must include a stable ID, severity, exact source location, reproducible attack,
observed result, violated invariant, missing regression, and smallest safe remediation. Acceptance must retain every
signer, signed-route enrollment, preflight, packet refresh, owner authorization, native qualification, live-panel,
production database, hosting, and deployment gate.
