# Execution contract v1

The architect writes this JSON before dispatch and validates it. The worker copies it exactly, records the validator digest, and does not act if any required effect is absent. This contract prevents setup, retries, diagnostics, and cleanup from being inferred after the fact.

The digest is SHA-256 of the parsed JSON object re-serialized with sorted keys, compact separators, UTF-8, and no ASCII escaping. It is not a hash of fenced Markdown, whitespace, indentation, or CRLF/LF bytes.

## Required shape

```json
{
  "contractVersion": "control-room-work-packet/v1",
  "packetId": "CR-X.Y-platform-purpose",
  "issueNumber": 123,
  "dispatchState": "ready",
  "baseCommit": "0123456789abcdef0123456789abcdef01234567",
  "branch": "worker/name/123-purpose",
  "allowedPaths": ["docs/hermes-reviews/example.md"],
  "packetAuthors": ["architect-profile"],
  "environment": {
    "checkout": {"policy": "preexisting-only", "effectIds": []},
    "dependencies": {"policy": "preexisting-only", "effectIds": []},
    "toolDownloads": {"policy": "forbidden", "effectIds": []},
    "network": {"policy": "authorized", "effectIds": ["E-GITHUB"]},
    "prompts": {"policy": "forbidden", "effectIds": []},
    "restarts": {"policy": "forbidden", "effectIds": []},
    "privilegeEscalation": {"policy": "forbidden", "effectIds": []},
    "persistentPermissions": {"policy": "forbidden", "effectIds": []},
    "temporaryFiles": {"policy": "authorized", "effectIds": ["E-SCRATCH"]},
    "helperPrograms": {"policy": "forbidden", "effectIds": []}
  },
  "attemptPolicy": {
    "maxTotalAttempts": 1,
    "onExhaustion": "stop",
    "diagnostics": "read-only"
  },
  "effects": [
    {
      "id": "E-SCRATCH",
      "action": "create one scratch directory and its enumerated files",
      "maxOccurrences": 1,
      "targets": ["one OS-temp child with a generated packet prefix"],
      "retryPolicy": "stop",
      "createsArtifact": true,
      "cleanup": {
        "effectId": "E-SCRATCH-CLEANUP",
        "method": "exact-target-native",
        "verify": ["resolved", "contained", "expected-type", "owned", "not-link-or-reparse", "absent"]
      }
    },
    {
      "id": "E-SCRATCH-CLEANUP",
      "action": "delete and verify the one scratch directory",
      "maxOccurrences": 1,
      "targets": ["the packet-created OS temporary child"],
      "retryPolicy": "stop",
      "createsArtifact": false,
      "cleanup": null
    },
    {
      "id": "E-GITHUB",
      "action": "claim, push one branch, open one PR, link PR",
      "maxOccurrences": 4,
      "targets": ["the named issue, branch, and PR"],
      "retryPolicy": "stop",
      "createsArtifact": false,
      "cleanup": null
    }
  ],
  "steps": [
    {
      "id": "S1",
      "description": "perform the bounded rehearsal once",
      "effectIds": ["E-SCRATCH"],
      "onFailure": "cleanup-then-stop"
    },
    {
      "id": "S2",
      "description": "remove and verify the bounded rehearsal scratch directory",
      "effectIds": ["E-SCRATCH-CLEANUP"],
      "onFailure": "stop"
    }
  ],
  "forbiddenEffects": ["all effects not identified above", "broad cleanup globs"],
  "gates": ["exact command and expected exit policy"],
  "independence": {"required": false, "excludedAuthors": []}
}
```

## Authoring rules

- Write a full 40-character immutable base commit.
- If a worker clone may have stale remote-tracking refs, include a separate bootstrap-fetch effect naming the exact remote/ref, occurrence maximum, and immutable commits that must become reachable. A generic GitHub-read effect does not authorize a fetch.
- Give every mutable or external action an effect ID. This includes coordination writes, checkout creation, dependencies, downloads, caches, helper source/binaries, generated keys, files, prompts, persistent choices, restarts, diagnostics, and cleanup.
- Set environment controls explicitly to `forbidden`, `preexisting-only`, or `authorized`. `authorized` requires effect IDs; the other policies forbid effect IDs.
- Count the worst case, not the hoped-for successful path. If three fault cases require three separately created files, authorize three. Prefer one artifact mutated and restored when that is safe, explicit, and supported by the step mapping.
- A retry never receives a free budget. Use `retryPolicy: stop` unless a bounded retry is genuinely required and included in `maxOccurrences` and `maxTotalAttempts`.
- List the cleanup method before dispatch. `exact-target-native` means no wildcard and an OS-native link/reparse check.
- Every disposable artifact's cleanup object names a distinct cleanup effect ID. That effect has its own maximum occurrence, creates no artifact, appears in a cleanup step, and is executed even after a producing/test step marked `cleanup-then-stop` fails.
- Use `exact-target-native` only for filesystem artifacts; its verification set is exactly `resolved`, `contained`, `expected-type`, `owned`, `not-link-or-reparse`, and `absent`.
- Use `exact-resource-native` for a named external resource such as a disposable Keychain item; its verification set is exactly `identified`, `expected-type`, `controlled`, `no-broad-selector`, and `absent`. The delete command/API must address the complete packet-generated identifier, never a prefix or search result.
- If a test might prompt, state which one-time response is authorized. `Always Allow`, policy edits, and restarts are forbidden unless they have their own effect IDs.
- An independent review lists every excluded source author. A reviewer matching any excluded author stops.

## Preflight acknowledgement

Before acting, the worker posts:

```text
CONTRACT READY
digest: <validator sha256>
worker/harness/model: <actual route>
base/branch: <exact>
preexisting tools: <versions; no installations performed>
worst-case effects: <effect id=count, ...>
cleanup method: <effect id=method, ...>
blocked mismatches: none
```

If any value differs, post `CONTRACT BLOCKED` and stop. The worker must not edit the contract to make it fit the host.

## Actual-ledger validation

At handoff, validate a JSON object with the original digest and chronological counts:

```json
{
  "contractDigest": "<validator sha256>",
  "occurrences": [
    {"effectId": "E-SCRATCH", "count": 1},
    {"effectId": "E-SCRATCH-CLEANUP", "count": 1},
    {"effectId": "E-GITHUB", "count": 4}
  ],
  "unexpectedEffects": []
}
```

Run:

```text
python skills/control-room-work-packets/scripts/validate_execution_contract.py contract.json --actual actual.json
```

To avoid creating a temporary contract file, pipe the issue's JSON block to the validator and use `-` as the contract argument. The contract and actual ledger cannot both use stdin in the same invocation.

Any unknown effect, over-budget count, unexpected effect, or digest mismatch makes the result noncompliant and the packet disposition `rejected — authorization deviation`.

