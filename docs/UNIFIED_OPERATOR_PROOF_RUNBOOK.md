# Unified installation operator proof runbook

This runbook turns the tested Agent Control Room source into an installation
without creating a second product for local workers or remote workers. It is
an owner-operated procedure. It does not authorize a deployment, a database
change, a credential change, a network listener, or a native harness call.

## The one rule that keeps both choices unified

Every installation uses one application composition and one authoritative
PostgreSQL database. A worker can be on the same computer as the controller or
on another enrolled computer, but it receives the same prepared task packet
and returns the same receipt, result, review, and correction records.

Local result files and remote artifact storage hold protected result bytes.
They do not select work, schedule work, approve work, or replace PostgreSQL.

## What must be prepared before either proof

The owner prepares these facts outside the repository and keeps private values
out of issue comments, task records, browser pages, logs, and this document:

1. One empty or approved Control Room PostgreSQL database, with the reviewed
   restricted application roles and migration state.
2. One protected result-byte directory for the installation. Its ownership,
   backup destination, and recovery procedure must be known to the owner.
3. One operator configuration assembled through the existing fail-closed
   configuration factory. It must identify the same database for all Control
   Room roles while retaining separate restricted logins.
4. A recovery point: the prior release, its configuration references, and the
   operator's steps to stop admission and drain work. Do not overwrite those
   items during an upgrade.

If any one of these is absent, stop before enabling automatic work. A passing
source test cannot fill in a missing production fact.

## Proof A — This computer

This proves a single computer can run the controller and a qualified local
worker without making the local worker a second authority.

### A1. Prepare without running work

1. Run the platform preparation checker with sanitized, already-observed
   worker facts. A ready preparation report is not permission to start a task.
2. Confirm the selected local connector profile, harness version, and worker
   capability match the prepared task plan. Do not discover these facts by
   launching a harness.
3. Confirm that the application has only the one approved PostgreSQL database
   and protected local result storage. A missing, substituted, or corrupt
   result directory must make startup refuse.

### A2. Qualify the existing harness once

The owner, from an attached terminal, runs the existing text-only local Hermes
qualification using the already-signed-in installation. The result must be a
sanitized pass record: no prompt, result text, account information, command,
path, token, or credential is retained in Control Room.

From the reviewed checkout, the owner-run command is:

```sh
npx --yes pnpm@11.19.0 run qualify:hermes:local -- --owner-attended
```

If Hermes reports that its current default model has no remaining allowance,
the owner may repeat the **separately authorized** one-shot check with a
temporary existing Hermes profile. This does not alter Hermes's default
settings and the chosen name is not included in the saved proof:

```sh
npx --yes pnpm@11.19.0 run qualify:hermes:local -- --owner-attended --profile OWNER_SELECTED_PROFILE
```

If the selected profile needs an already-configured temporary model override,
the owner may add `--model OWNER_SELECTED_MODEL --provider
OWNER_SELECTED_PROVIDER`. This supports local Ollama model tags such as
`qwen3.8:27b-long` as well as hosted providers. Do not guess names or change
Hermes configuration to make this pass. Choose an existing, owner-approved
profile/provider/model and retain only the sanitized JSON result.

The command requires fresh owner authorization for each non-dry attempt. Its
matching `--dry-run` form checks only the bounded invocation shape and does
not contact Hermes.

If it refuses or ends early, record the safe `failureReason` only: it will say
whether the local runner was unavailable, timed out, returned no final result,
returned no model response, ran out of model allowance, lost model
authentication, selected a model that is no longer available, encountered a
temporary model rate limit, needs provider credits, exited unsuccessfully, or
returned an unexpected final result. A temporary rate limit means wait for the
provider's cooldown. During a local-model qualification, a credits result means
the selected profile did not reach that local model and is still using a hosted
provider. Neither is evidence that
the profile login is broken. It deliberately omits the command output, account,
provider and machine details. Leave automatic work off. Do not retry it
automatically and do not repair the user's harness from Control Room; the output
explicitly says that a fresh owner authorization is required for any later
attempt.

### A3. Prove a completed result survives a restart

Using disposable work only:

1. Deliver one controller-prepared task to the qualified local bridge.
2. Let the bridge save its one schema-checked terminal result before returning
   it to Control Room.
3. Stop the application through its normal drain procedure after the saved
   result exists, then start a new application composition over the same
   database and protected result directory.
4. Confirm the result reaches the ordinary pending-review state exactly once
   and the harness is not launched a second time.
5. Confirm the worker has no ability to approve the result or release its own
   task capacity.

An absent or ambiguous terminal result remains unresolved. It is not safe to
infer success or restart the task.

### A4. Prove backup and recovery

Create a disposable backup, restore it into a separately disposable target,
and verify the restored database identity, restricted roles, schema, relevant
rows, and protected result-byte inventory. Do not promote the restored copy.
Record only digests, timestamps, release identity, and pass/fail evidence.

## Proof B — Several computers

This adds an enrolled remote worker to the same installation. It does not add
a second scheduler, broker, database, task ID, or review path.

### B1. Enroll and connect one worker privately

1. Prepare the remote computer with the same sanitized preparation process.
2. Enroll the worker with its exact adapter version, capability record, and
   certificate identity through the approved private connection design.
3. Bind the private certificate-checked native connection to the existing
   managed session service. The source-side host already checks the actual TLS
   peer certificate; it never trusts a forwarded identity header.
4. Keep the listener private. Do not publish its address, keys, certificates,
   account data, or routing details in the repository or application records.

The source only becomes ready after the enrollment, protocol version, and
certificate identity agree. A revoked or incompatible worker must stay unable
to receive new work.

### B2. Run the controlled two-computer journey

Using disposable data and one intended worker:

1. Send one prepared packet and confirm its receipt is recorded once.
2. Confirm a different connected worker cannot receive or substitute for it.
3. Send progress and one completed result from the intended worker, and check
   that it enters the same ordinary pending review used by a local worker.
4. Disconnect before a receipt, reconnect, and confirm the controller reports
   uncertainty rather than sending the task again.
5. Reconnect with the original valid receipt and confirm it reconciles the
   existing record only.
6. Repeat the connection attempt with a revoked worker and with an unsupported
   adapter version. Both must be refused before a task can be delivered.
7. Request a correction from review and prove the revised result follows the
   same single-result review path.

## Evidence that is sufficient to call an installation operational

The owner retains a small sanitized record for each proof. It must show:

| Required fact | Local proof | Multi-computer proof |
| --- | --- | --- |
| One approved PostgreSQL authority | required | required, same database |
| Restricted roles and migration state | required | required |
| Protected result bytes recover after restart | required | required |
| Qualified worker identity and compatible connector | required | required for each worker |
| Task delivered once and received once | required | required |
| Result reaches owner review once | required | required |
| Disconnect does not create a retry | required where applicable | required |
| Wrong/revoked/incompatible worker refused | local policy refusal | required |
| Backup restored into a disposable target | required | required |
| Stop, drain, update, and rollback procedure | required | required |

The evidence record must not contain secrets or raw host information. If any
row is missing, describe the installation as prepared or partially proven—not
operational.

## Upgrade, rollback, and incident rules

- Stop new task admission first; let owned work drain.
- Preserve unresolved delivery and result records. A failed update does not
  authorize re-running them.
- Keep the previous release and recovery material until the replacement passes
  the same preparation and restart proof.
- If the private transport, database, result storage, or supervisor becomes
  uncertain, fail closed for new work and investigate the original records.
- A browser, local file, remote artifact store, worker, or connection may
  report evidence. None can independently approve a result or make a task
  complete.

## Source evidence that supports this runbook

The application already has one task coordinator composition, one
controller-to-worker packet, one receipt path, and one result/review path.
Source tests cover local and remote route doubles, correction handling,
two-worker targeting, reconnect, revocation, incompatible-version refusal,
and protected local terminal-result recovery. Those tests support this
procedure, but do not replace the owner-operated proofs above.

Before an owner-run proof, contributors can run the focused source check:

```sh
npx --yes pnpm@11.19.0 run test:unified-topology
```

It creates only disposable test data. It does not qualify a harness, open a
listener, contact a provider, create a production database, or make an
installation operational.
