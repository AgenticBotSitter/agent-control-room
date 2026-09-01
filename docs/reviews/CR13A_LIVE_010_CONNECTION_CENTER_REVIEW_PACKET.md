# CR13A-LIVE-010 independent review packet

## Frozen target

- Implementation: `e4cb8d69b4dbe17f560303a1edad08871fcc575b`
- Base: `91398c18560f25785ee4dc83ff18b9b42406f15b`
- Scope: protected read-only Connection Center inventory and compatibility diagnostics
- Producer status: implementation candidate only

Review only the exact commit. Do not repair it, merge it, or reinterpret a failed case as acceptance.

## Required review

1. Confirm `/api/v1/connections` authenticates before any roster-source call and derives tenant scope only from the
   verified owner session.
2. Confirm a source roster is rebuilt through the accepted Hermes 0.21 connection-roster contract and that digest,
   tenant, chronology, duplicate identity, expiry, route, and profile drift fail closed.
3. Confirm the public projection and browser reader are strict, digest-bound, bounded to 32 entries, and recursively
   non-authorizing.
4. Confirm no hostname, address, port, SSH target, path, credential, protected value, profile identity, private runtime
   detail, native locator, or raw provider content can reach the route or UI.
5. Confirm “reviewed exact revision” cannot be presented as native-qualified, live, healthy, available, or eligible.
6. Confirm the empty local-pilot roster is honest and no fixture, installed binary, earlier test, or ambient host fact is
   substituted as enrollment.
7. Confirm the page and API introduce no write route, connect/start/qualify control, external client, credential access,
   approval, lease, dispatch, retry, command, or execution path.
8. Confirm the client imports remain browser-safe and the production client build does not pull Node crypto or connector
   implementation modules into the browser.

## Reproduction commands

```text
pnpm test:cr13a-connections
pnpm test:cr13a
pnpm check
pnpm lint
pnpm test:build
pnpm db:verify
node scripts/qualification/platform-key-store-stage-zero.mjs --platform macos
git diff --check 91398c18560f25785ee4dc83ff18b9b42406f15b...e4cb8d69b4dbe17f560303a1edad08871fcc575b
```

## Effect boundary

Repository reads and deterministic local tests only. Do not start a persistent server, contact Hermes, open SSH, read or
write credentials, launch a native process, call a provider, access a production database, deploy, or perform any other
external effect. Return a report with severity, exact file/line evidence, reproduction, observed result, expected result,
and disposition. Any High or Medium finding rejects the candidate. A clean report may accept only the exact
provider-disabled, connection-disabled implementation snapshot.
