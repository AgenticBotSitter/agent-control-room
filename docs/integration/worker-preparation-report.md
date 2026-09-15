# Worker preparation report

Offline human-readable explanations over accepted `checkPrivateWorkerPreparationV1`
output. The explainer reads one or two explicitly supplied fact documents, runs
the existing checker, and renders fixed sentences from the accepted result only.

## Command

```sh
node --import tsx scripts/explain-worker-preparation.mjs --input facts.json [--previous older-facts.json]
```

`--help` prints usage. Malformed or unevaluable input exits 1 with the generic
refusal `Control Room worker preparation explanation refused supplied facts.`
on stderr. No host scan, credential read, or endpoint discovery happens; the
checker starts no harness and the comparison grants no execution authority.

## Disclosure contract

Allowed in output: readiness states (`ready`, `not-ready`, `refused`), the
`macos`/`linux` platform, finite operation names with `available`/`unavailable`,
finite reason codes mapped to fixed sentences, and fixed explanations.

Never in output: identities (tenant, node), endpoint digests, manifest or
evidence digests, discovery fingerprints, raw profiles, arbitrary labels, or
input text. Unknown future reason codes render one fixed generic sentence.

## Supported modes

The checker starts no harness (`startsHarness: false`) and grants no execution
authority (`grantsExecutionAuthority: false`). A ready result qualifies only the
supplied preparation facts; macOS Codex limits apply and no new Windows
execution support is added.
