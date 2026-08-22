# New project checklist

This is the standard plug-in path for any future project. A project does not copy Wayfarer or Content Blooms internals.

## 1. Declare the boundary

- Give the source and adapter stable IDs.
- Select `control_room_native`, `source_scheduled`, or `advisory` authority.
- Declare supported reads and any future commands in the manifest.
- Keep source records authoritative; Control Room stores projections only.

## 2. Publish safe operational data

- Project summary and health.
- Work items with both normalized and domain states.
- Executions, blockers, attention items, and deep links.
- An opaque, monotonically advancing change cursor.
- No transcript bodies, prompts, draft bodies, raw media, signed URLs, secrets, or full exceptions.

## 3. Describe work as capabilities

- Name the required capability, not a specific machine.
- Register each viable route separately: runtime, worker, verification state, benchmark, cost, quality, and privacy class.
- Run only relevant benchmarks. Hardware discovery can rule out impossible routes before expensive tests.
- Refresh volatile telemetry continuously and expire stale benchmark claims after meaningful runtime, driver, model, or hardware changes.

## 4. Choose allocation behavior

- `exclusive`: reserve the worker for selected projects.
- `preferred`: favor selected projects but permit fallback.
- `shared`: weighted fair-share across eligible projects.
- `opportunistic`: consume otherwise idle capacity.
- `manual`: require an operator pin.

Projects can set preferred or avoided workers, allowed routes, a pinned worker, deadline, cost limit, provider permission, and quality-fallback permission.

## 5. Prove the adapter offline

- Add a synthetic fixture pack.
- Validate schemas and contract version.
- Test stable references, cursors, replay idempotency, tenancy, redaction, timeouts, version mismatch, and unsupported commands.
- Demonstrate at least one busy-worker fallback and one no-eligible-route blocker.

## 6. Request live integration separately

A live phase needs explicit approval for credentials, network path, deployment, polling cadence, command permissions, and rollback. CR-0 through CR-2 do not confer that authority.
