# Reusable cross-harness connector conformance runner

Issue #256. Module: `src/connector-conformance/v1/**`.
Tests: `tests/connector-profile.test.ts` and `tests/canonical-text-result.test.ts` (conformance
cases appended to the existing lane-reachable files, both run by `pnpm test:contracts`).

## What it is

One importable, effect-free runner that a new harness contributor calls to exercise the **existing**
connector-profile and canonical-text-result rules with caller-supplied profiles and disposable
observations, instead of copying separate tests for each harness. It returns deterministic
per-scenario evidence: `pass`, `fail` or `unsupported`.

It is a **testing API, not a production port**. It reads no clock, file, registry, network or
credential store; it parses and constructs only through the reusable public functions
`parseConnectorProfileV1`, `connectorOperationAdmissibleV1`, the finite `connectorOperationNamesV1`
list and `createCanonicalTextResultV1`. It adds no harness contract, publisher, scheduler, registry,
review lifecycle or permission model, and it enables nothing: every report carries
`nativeQualification: false` and an empty `enabledOperations` list, because synthetic conformance is
not native qualification.

## Adapter input shape

```ts
runConnectorConformanceV1({
  profiles:     Record<string, unknown>,                        // caller-supplied profiles, keyed by id
  observations?: Record<string, ConnectorConformanceObservationV1>, // disposable text or raw bytes
  scenarios:    ConnectorConformanceScenarioV1[],                // what to compare, in order
})
```

`profiles` values are parsed by the existing `parseConnectorProfileV1`, so an invalid profile is
refused rather than repaired. A missing `profiles`/`observations`/`scenarios` entry is treated as
empty (the runner still returns a report). Observations are either
`{ form: "utf8_text", text }` or `{ form: "raw_bytes", bytes }` — raw bytes exist only so a
contributor can show which observations the current text-only boundary cannot express.

Each scenario declares one comparison:

| Field | Meaning |
| --- | --- |
| `scenarioId` | `^[a-z0-9][a-z0-9._-]{2,79}$`, unique within a run, used in refusals |
| `rule` | one of the ten finite rules below |
| `profileId` | key into `profiles` |
| `operation` | required for `operation_availability` and `insufficient_evidence`; optional otherwise (defaults to `result`), always one of `connectorOperationNamesV1` |
| `observationId` | required for the seven result rules; key into `observations` |
| `identity` | optional exact `{ lineage, source }`; when absent the runner derives a deterministic disposable identity from `scenarioId` |
| `observedAt` | optional synthetic instant; defaults to the fixed fixture instant so reports stay reproducible |
| `expect` | `admitted`, `refused` or `unsupported` — what the contributor declares the existing rule does |

Structural validation runs before any evaluation: a malformed plan throws
`connector_conformance_scenario_invalid:<scenarioId>:<field>` instead of producing partial evidence.
Declared `rule` and `operation` values are checked against the existing finite lists, so no new rule
or operation name can be invented through this API.

## Rules

| Rule | Existing behaviour exercised |
| --- | --- |
| `source_identity` | exactly one of `sourceRevision` / `sourcePackage` is present |
| `operation_availability` | `connectorOperationAdmissibleV1` admission or refusal reason |
| `insufficient_evidence` | a declared-but-unqualified operation stays refused for insufficient evidence |
| `result_envelope` | the constructor admits the operation and projects its evidence into the envelope |
| `lineage_identity` | projected `lineage`, `source`, exact UTF-8 `sizeBytes` and `contentHash` equal the caller's |
| `content_bytes` | byte limit, empty/whitespace refusal and multibyte Unicode size |
| `content_encoding` | text-only boundary: lone surrogates refuse, raw bytes are `unsupported` |
| `result_determinism` | identical inputs reproduce an identical `resultDigest` and envelope |
| `input_immutability` | caller inputs are unchanged, the result is deep-frozen, operation admission is unchanged |
| `review_flags` | `reviewRequired` stays `true`; completion/quality/authority/retry/resume flags stay `false` |

## Report shape

```ts
{
  schema: "control-room.connector-conformance-report/v1",
  runner: "control-room.connector-conformance-runner/v1",
  nativeQualification: false,
  enabledOperations: [],
  profilesEvaluated: string[],   // sorted, deduplicated
  scenarios: [{ scenarioId, rule, expectation, outcome, reasonCode, operation?, profileDigest?,
                resultDigest?, contentHash?, sizeBytes?, resultFrozen? }],
  counts: { pass, fail, unsupported },
  reportDigest: "sha256:…",
}
```

`pass` means the existing rule behaved as declared, `fail` means it did not (including a wrong
`expect`), and `unsupported` means no existing boundary can express the observation — an
`unsupported` scenario never counts as a pass. `reasonCode` carries the refusal/violation code
(for example `evidence_insufficient_source_inspected`, `content_unavailable`,
`utf8_text_boundary_required`, `caller_input_mutated`). The report is deep-frozen and
`reportDigest` is the canonical digest of everything above it, so identical inputs produce a
byte-identical report.

## Runnable consumer example

From the repository root, with the pinned Node toolchain:

```sh
node --import tsx --input-type=module -e '
import { runConnectorConformanceV1 } from "./src/connector-conformance/v1/index.ts";

const operation = (status, evidence, reasonCode) => ({ status, evidence, reasonCode });
const names = ["submit","status","result","events","cancel","resume","read","usage","artifacts"];

const syntheticProfile = {
  schema: "control-room.connector-profile/v1",
  connectorId: "connector.example.v1",
  connectorVersion: "1.0.0",
  harness: "other",
  harnessVersion: "0.0.1",
  sourceRevision: "a".repeat(40),
  transport: "rest",
  isolation: "adapter_process",
  credentialResolution: "harness_native",
  distribution: "invocation_only",
  operations: Object.fromEntries(names.map(name => [name,
    name === "result"
      ? operation("supported", "native_qualified", "reason_result_native")
      : operation("unsupported", "source_inspected", "reason_unavailable")])),
  resultContract: { forms: ["utf8_text"], maximumBytes: 65536, additionalAttachments: false },
};

const report = runConnectorConformanceV1({
  profiles: { synthetic: syntheticProfile },
  observations: { plain: { form: "utf8_text", text: " exact result\n" } },
  scenarios: [
    { scenarioId: "source-identity", rule: "source_identity", profileId: "synthetic", expect: "admitted" },
    { scenarioId: "result-envelope", rule: "result_envelope", profileId: "synthetic", operation: "result", observationId: "plain", expect: "admitted" },
    { scenarioId: "read-unavailable", rule: "operation_availability", profileId: "synthetic", operation: "read", expect: "refused" },
    { scenarioId: "determinism", rule: "result_determinism", profileId: "synthetic", operation: "result", observationId: "plain", expect: "admitted" },
  ],
});

console.log(JSON.stringify({ counts: report.counts, nativeQualification: report.nativeQualification,
  enabledOperations: report.enabledOperations, outcomes: report.scenarios.map(s => [s.scenarioId, s.outcome, s.reasonCode]) }, null, 2));
'
```

The run prints `counts` `{ pass: 4, fail: 0, unsupported: 0 }`, `nativeQualification: false`,
`enabledOperations: []` and the per-scenario outcome list.

## Adding a new harness

1. Build one strict `control-room.connector-profile/v1` value for the harness and pass it under
   `profiles`. The runner parses it with the existing schema; there is nothing to register.
2. Pass disposable observations under `observations` — text only, plus raw bytes where the harness
   produces bytes the text boundary cannot accept.
3. Declare scenarios for the rules that matter, then assert on `counts`, `reasonCode`, `resultDigest`
   and `contentHash`. Identical inputs must reproduce an identical `reportDigest`.
4. Keep the assertions inside an existing lane-reachable test file (`pnpm test:contracts`), and never
   treat `unsupported` or synthetic `pass` evidence as live qualification.

## Explicit gaps

- Raw byte observations are reported `unsupported`: the existing result boundary accepts text only,
  and this runner must not decode bytes on its own.
- Live native qualification, provider calls, credentials, production/database effects and
  deployment are out of scope; a synthetic profile that declares `native_qualified` still only
  proves the rules behaved, not that a real harness was exercised.