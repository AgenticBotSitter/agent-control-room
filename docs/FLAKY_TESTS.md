# Flaky-test quarantine

The quarantine is an emergency, time-bounded isolation mechanism, not a way to
delete coverage. The merge gate skips only the named test while the
`Quarantined tests (non-blocking)` job runs it and reports its real result.
Failures in that reporting job do not fail the merge gate; failures from every
non-quarantined test still do.

Add an entry to `tests/quarantine.json` only after opening a GitHub issue:

```json
[{ "test": "tests/example.test.ts::exact test name", "issue": "#123", "added": "2026-09-28", "owner": "test maintainer" }]
```

- `test` is the repository-relative file, two colons, and the exact Node test name.
  Only Node `*.test.ts`, `*.test.tsx`, `*.test.mjs`, and `*.test.js` files are
  supported. Browser `*.spec.ts` journeys require their own isolated services
  and are rejected rather than falsely appearing quarantined.
- `issue` must be `#` followed by the issue number.
- `added` is the UTC date. CI rejects entries after 14 days, so fix or renew
  them through review rather than allowing silent permanent quarantine.
- `owner` is the role responsible for the fix, not a person's private name.

Run `node scripts/check-test-quarantine.mjs` before pushing. Remove the entry as
soon as the issue is fixed, then run the formerly flaky test repeatedly.
