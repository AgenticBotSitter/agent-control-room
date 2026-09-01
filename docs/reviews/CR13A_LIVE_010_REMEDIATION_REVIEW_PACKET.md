# CR13A-LIVE-010 identity-redaction remediation review packet

## Frozen target

- Remediation: `c32bb1908323d9acb2e891722c1fd4657334c741`
- Rejected predecessor: `e4cb8d69b4dbe17f560303a1edad08871fcc575b`
- Product base: `91398c18560f25785ee4dc83ff18b9b42406f15b`
- Scope: protected read-only Connection Center inventory and compatibility diagnostics
- Producer status: remediation candidate only

Review only the exact remediation commit. Do not repair it, merge it, or convert the rejected predecessor into a pass.

## Required reproduction

1. Reproduce the predecessor defect with an accepted signed enrollment whose `connectionId` and `nodeId` contain an IP,
   hostname, or port and confirm those values reached the predecessor projection.
2. Confirm the remediation never copies source `connectionId`, source `nodeId`, tenant identity, source-result digest, or
   roster digest into the public projection.
3. Confirm each connection receives only an exact `connection:inventory:NNN` presentation reference and each distinct
   node receives only an exact `node:inventory:NNN` presentation reference, with no hash-derived or reversible locator
   material.
4. Confirm the server still compares the rebuilt roster tenant and evaluation time against authenticated read scope
   before projection, and that authentication still occurs before any roster read.
5. Confirm strict parsing and the projection digest reject altered references, extra source identifiers, extra tenant
   identity, and any other response shape drift in both server and browser paths.
6. Recheck the original packet requirements: bounded roster reconstruction, honest empty state, exact-version semantics,
   no locator/credential/private material, no write or connect control, browser-safe imports, and no authority expansion.

## Reproduction commands

```text
git diff e4cb8d69b4dbe17f560303a1edad08871fcc575b...c32bb1908323d9acb2e891722c1fd4657334c741
pnpm test:cr13a-connections
pnpm test:cr13a
pnpm check
pnpm lint
pnpm test:build
git diff --check 91398c18560f25785ee4dc83ff18b9b42406f15b...c32bb1908323d9acb2e891722c1fd4657334c741
```

## Effect boundary

Repository reads and deterministic local tests only. Do not start a persistent server, contact Hermes, open SSH, read or
write credentials, launch a native process, call a provider, access a production database, deploy, or perform another
external effect. Return severity, exact file/line evidence, reproduction, observed and expected result, and disposition.
Any High or Medium finding rejects the remediation. A clean report may accept only this exact connection-disabled
implementation snapshot.
