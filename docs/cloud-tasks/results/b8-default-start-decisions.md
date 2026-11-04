# b8-default-start decisions

```text
Choice D1: Default pointer is a nullable column on D01a's state row with a composite FK (tenant_id,project_id,default_preset_id) to presets ON DELETE RESTRICT.
Options: separate default table; pointer stored in P71 selection layer; flag column on presets.
Why: The task forbids a separate default store and requires a composite FK with RESTRICT. A column on the state row shares the single version counter and lock, so set and save are atomic with no extra lock order. With MATCH SIMPLE, NULL means unset. Reusing the row's project key makes a cross-project pointer structurally impossible.
Affected spec item: 2 (§3.1)
```

```text
Choice D2: Service delete clears the pointer in the same state UPDATE that bumps the version, before DELETE of the preset; result operation stays 'delete'.
Options: refuse delete of the default; new operation 'delete_default'; ON DELETE SET NULL.
Why: The task requires the service to clear the pointer and delete atomically under one lock and one version, and requires raw SQL delete to refuse with 23503. SET NULL would make raw delete succeed. A new operation would widen the grammar beyond what the task lists.
Affected spec item: 2, 4 (§3.4)
```

```text
Choice D3: Result grammar widened by dropping and re-adding D01a's last_result CHECK in the D01b migration; null presetId only for set_default.
Options: separate CHECK constraint added alongside; jsonb schema trigger.
Why: Two overlapping CHECKs could not widen the enum, because D01a's would still refuse it. A single replaced predicate keeps shape, size and types identical, and the down restores D01a's predicate verbatim.
Affected spec item: 4 (§3.2, §3.3)
```

```text
Choice D4: PUT {presetId:null} when already unset is still a versioned write (version+1, result set_default/null).
Options: no-op 200 without version change.
Why: A no-op would have nothing to replay and would make the same-key/latest-key rules diverge from D01a. Uniform versioning keeps the 20-caller race oracle simple: exactly one winner.
Affected spec item: 3 (§4)
```

```text
Choice D5: Setting the default to a currently stale preset is allowed; staleness blocks Prepare, not the pointer.
Options: refuse set_default on stale presets.
Why: The owner chooses the default. Staleness comes from the current roster and policy, which change outside this write path, so refusing at write time would not stop later staleness. Revalidation on pick, which is required anyway, explains it and blocks preparation. Writes stay free of roster reads and checker spawns, as in D01a.
Affected spec item: 5 (§6.2)
```

```text
Choice D6: Default fills the form only; it never becomes or writes the P71 selection layer.
Options: copy the default into the P71 selection layer on set.
Why: The task says selecting a default never copies settings into state, and that only explicit Save / Save as default persist. U82's selection layer stays the separate saved/whole-layer path that preserves providerRoute. A default carries B8 roles and counts only.
Affected spec item: 5, 8 (§6, §7)
```

```text
Choice D7: Re-preparing after an edit creates a new intake (new request id), never revises the prepared one.
Options: reviseLoopDraft on the existing request.
Why: The task requires an immutable replacement with renewed Confirm and acceptance. The existing revise path is used only by Confirm for a description change. A new intake reuses all existing P71 admission without a new admission path.
Affected spec item: 5 (§6.7)
```

```text
Choice D8: Transport gets one anchored alternative for exactly /loop-selection/default; POST needs none; no budget entry.
Options: broaden the D01a preset regex to cover /default; add DELETE for clear.
Why: The narrowest change. Clear is PUT null, so DELETE is never needed. The worst-case body (about 5.6 KiB) fits the 8 KiB default.
Affected spec item: 6 (§5)
```
