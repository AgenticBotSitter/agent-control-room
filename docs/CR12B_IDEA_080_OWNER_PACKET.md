# CR12B-IDEA-080 future native qualification packet

**Current disposition:** Blocked. Do not enter a code, approve Keychain, start Hermes, install/update Hermes, or expose a
protected value for this packet. It records the later bounds but is not current effect authority.

## Frozen future limits

- Runtime: Hermes Agent `0.21.0`, exact reviewed revision `a2907a8bcdd8e5cdfbd9d6f7ec8b064ce7e40b5b`;
  upstream release revision `29112bef099274229cadff79cdff7bf7b99c4b77` is an ancestor exactly 60 commits behind.
- Adapter: `adapter.hermes.gateway.v2` `2.0.0`.
- Native attempts: one.
- Provider calls: one.
- Elapsed window: at most 300 seconds.
- Retained sanitized evidence: at most 256 KiB.
- Tools and MCP servers: zero.
- Profile/workspace: disposable and removed before completion.
- Protected-value custody: Hermes-native; Control Room receives only a custody-evidence digest.
- Retry: never automatic. Unknown state after the marker is terminal ambiguity.

## Ordered future stages

1. Verify the exact installed runtime and accepted source contract.
2. Create one disposable profile and empty workspace.
3. Verify zero callable tools and zero MCP servers.
4. Verify Hermes-native protected-value custody without reading the value.
5. Persist the exact pre-call marker.
6. Run one filtered turn.
7. Verify usage plus sequence replay without resubmission.
8. Interrupt and reconcile the session.
9. Remove every disposable resource.
10. Emit only the bounded sanitized receipt.

## Why it is still blocked

The repository intentionally contains no native gateway port, accepted native receipt, or owner window. IDEA-090 closed
the durable admission-consumption contract and IDEA-105 refreshed the exact source pin, but their integration and a new
exact owner authorization remain mandatory. A passing source preflight or injected simulation is never native evidence.
