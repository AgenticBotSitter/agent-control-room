# Independent review format

## Independence gate

Before reading conclusions, compare the reviewer identity/profile with every author under review. If the review requires independence and any match exists, stop and request reassignment. Model diversity does not cure author overlap.

## Review order

1. Verify exact changed paths against the issue.
2. Compare immutable base/head commits and dependencies.
3. Reconstruct the packet’s authorization ledger.
4. Check every effect, including failed attempts, helpers, prompt choices, persistent permissions, installs, downloads, and restarts.
5. Verify observed/documented/inference/blocked/unsupported labels.
6. Check cleanup target-by-target, not by a final glob or author assertion.
7. Reconcile validation commands and actual exit codes.
8. Compare reports for contradictions and claims that exceed their evidence.

## Required distinctions

- Disclosure is not authorization.
- Technical success is not packet acceptance.
- Cleanup success does not erase an authorization deviation.
- Unit/fake evidence is not native-host evidence.
- Source proof is documented evidence, not an observed invocation.
- Process relaunch, service restart, container restart, host reboot, and account/profile change are different events.
- Owner/mode checks exercised by one UID do not establish cross-UID containment.
- A reviewer cannot independently accept their own work.

## Per-report disposition

Use exactly one:

- `accept` — evidence and authorization both satisfy the packet;
- `accept as research only` — useful evidence, but proposals are non-binding and no acceptance gate is closed;
- `changes required` — focused report or cleanup repair can resolve the issue without new authority;
- `blocked` — missing evidence requires new authority, external state, or a different independent reviewer;
- `reject` — material authorization deviation, unsafe behavior, secret exposure, scope expansion, or unsupported conclusion prevents acceptance.

Give exact repair notes and identify whether a new probe is forbidden, unnecessary, or separately authorized. Do not merge.

## Cross-report close recommendation

State which gates are satisfied, which remain blocked, which findings require implementation remediation, and which belong to later deployment/packaging. Name exact PR heads reviewed. A batch cannot close when any required report is self-reviewed, has unresolved authorization deviations, lacks cleanup proof, or overstates blocked evidence.
