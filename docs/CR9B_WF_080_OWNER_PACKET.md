# CR9B-WF-080 owner-attended Unreal benchmark packet

**Contract:** `control-room-wayfarer-unreal-benchmark/v1`
**Benchmark:** `benchmark:wayfarer:unreal-scene-render:v1`
**Current state:** Disabled; no native attempt occurred
**Authority:** This packet grants no approval or execution authority

## Purpose

This packet freezes the only scene/render workload that may later qualify Unreal for the Wayfarer model-render route. It is a preparation and evidence contract, not permission to install, open, or run Unreal.

The benchmark renders one owner-supplied private scene at 1920 by 1080 for 300 frames. One attempt contains one warm-up run and three measured runs; median wall-clock time is the aggregation rule. The attempt ceiling is 15 minutes, 16 GiB memory, 64 GiB scratch, zero provider cost, zero network, and one attempt with no automatic retry.

Control Room stores only digests and safe measurements. Private scene bytes, render bytes, paths, tool locations, host names, credentials, raw command output, and usable storage locators remain outside the control plane.

## Required readiness evidence

All thirteen gates must be current and bound to one assessment before an owner window can even be proposed:

1. exact benchmark packet;
2. immutable private-scene identity;
3. pinned Unreal tool identity;
4. qualified native executor;
5. separately signed node approval attestation;
6. hardware environment fingerprint;
7. GPU capability evidence;
8. scratch capacity and encryption evidence;
9. offline network enforcement;
10. measured clock and metric collection;
11. evidence capture and integrity;
12. cleanup and ambiguity procedure;
13. a fresh owner-attended single-use window.

Evidence is digest-only in repository-visible records. Actual private identities and locators must remain in their protected native stores.

## Owner window procedure

This procedure may be used only after a later explicit authorization names the exact packet and assessment digests and confirms every prerequisite as current.

1. Re-read the readiness ledger and stop unless all thirteen gates are met.
2. Recompute the packet, scene, tool, node, and environment identities. Any mismatch stops before launch.
3. Confirm the exact one-use owner window and separately signed node approval attestation are current.
4. Confirm Unreal already exists and is qualified. Installation, download, login, license change, plugin installation, or repair is outside this packet.
5. Confirm the private scene and scratch location through the protected native boundary without copying their values into Control Room.
6. Confirm network enforcement, zero provider calls, the 15-minute ceiling, one-attempt ceiling, evidence collector, and cleanup procedure.
7. Create the durable attempt claim. Immediately before native launch, write the pre-effect marker.
8. Run the fixed warm-up and three measured renders. Record trusted times, wall-clock milliseconds, frames per second, peak memory, peak scratch, output size, and output content identity.
9. Capture node, tool, scene, environment, network-denial, execution, measurement, output, and cleanup evidence digests.
10. Stop after the first terminal result. A measured pass becomes only an independent-review candidate; it does not activate Unreal or complete a media stage.

## Stop and ambiguity rules

- Any missing, expired, reordered, or mismatched prerequisite stops before launch.
- Any request to broaden frames, resolution, runs, duration, cost, network, platform, scene, tool, node, or attempt count requires a new packet.
- A definite pre-marker refusal is blocked evidence and does not consume the native attempt.
- Once the marker exists, restart, timeout without trusted settlement, lost output identity, lost cleanup evidence, or unknown child state becomes terminal ambiguity.
- Ambiguity never retries automatically. It requires authoritative reconciliation and a new packet/assessment/approval path before any future attempt.
- A measured failure is terminal for this packet. It cannot be relabelled as blocked or retried under a new request ID.

## Current disposition

Only the exact benchmark packet gate is met. The other twelve gates are missing, so the accepted current outcome is disabled. No Unreal process, scene read, GPU work, render output, network, storage action, provider call, approval, or external effect occurred.
