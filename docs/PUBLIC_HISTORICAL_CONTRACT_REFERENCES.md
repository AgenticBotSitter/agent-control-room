# Historical contract references in the public candidate

Publication review finding, 2026-09-07. This is private review evidence, not a file
to copy wholesale into the public release.

Independent reviewers identified historical acceptance pins in ready-frontier and
Idea Lab contracts. Main verified both commit objects exist in the private checkout:

- `adf0804a52a13d544192afc90506c3e989254ffd`: AUTO-030 authorization-time fix.
- `c71de92dbce49ec1b8ae2af7977384c535d265fd`: Hermes source-preflight binding fix.

`src/ready-frontier/v1/no-relay-types.ts` and `no-relay-schemas.ts` additionally pin
an acceptance-review digest. Idea Lab panel-packet and native-qualification source
bind compatibility evidence to the second commit. These values are contract literals,
not embedded credentials. Their presence does not disclose the referenced commit
contents or authorize publishing private Git history.

## Required disposition

Do not silently replace these constants with a public commit, remove their checks,
or advertise the historical private evidence as publicly reproducible acceptance.
The current source snapshot can be inspected and its documented synthetic demo tested
without declaring these historical live-activation prerequisites satisfied.

Before source publication, document this distinction in the public architecture/
limitations guide and review the exact affected paths. Retaining historical contract
identifiers preserves existing checks; a generalized public activation contract and
new reproducible qualification evidence belong to the later live-integration work.
Any original private evidence stays private. This finding is a provenance and
reproducibility limitation, not by itself evidence of leaked authentication material.

The subsequent public architecture clarification is now present in the candidate,
durable draft and reconstruction receipt. Independent review of its exact hash
found no actionable wording issue; see the architecture content-review receipt.
No protocol rules or GitHub files were changed. The public text contains none of
the private commit values above and makes no live qualification claim.
