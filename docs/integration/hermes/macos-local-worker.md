# Local Hermes worker on macOS

This document describes the **single-computer** Control Room option: a person
can use Control Room and Hermes Agent on the same Mac without treating Hermes
as a remote machine. It is the same Control Room product and uses the same
project, task, result, review, correction, and approval records as a
multi-computer installation.

## Two compatible local paths

`createHermesMacosLocalSessionPortV1` connects the already-reviewed Hermes
session adapter to one Mac-owned private port, **when that Hermes installation
exposes the pinned session-tool interface**. It allows only the three Hermes
session operations Control Room already supports:

- start one task turn;
- read that turn's status;
- read its bounded result.

The adapter passes only a stable local service label such as
`service:marvin-hermes`. It does not contain a hostname, filesystem path,
login, token, model name, shell command, or process-control instruction.
Those private details remain with the Mac integration owned by the operator.

The current Mac installation is Hermes Agent 0.21.3. Its documented CLI has a
different, structured `--format stream-json` one-shot result format. The
`hermes-021-v1` adapter now parses that actual terminal report and carries its
bounded text, token counts and elapsed time to the existing result/review
path. Its private port is still responsible for launching Hermes; Control Room
never stores or exposes the command, its login, or the selected model.

The result still follows the normal Control Room result-publication and owner
review path. A local Hermes result is not automatically accepted just because
it came from the same computer.

Control Room gives an initial Marvin task its own pinned plan form, and gives
a requested correction a separate pinned correction form. That prevents an
old generic Hermes task from being silently treated as a Marvin task and keeps
the correction tied to the exact reviewed result it replaces.

## What is deliberately not claimed yet

The source adapters have unit tests, but neither has contacted Marvin's live
installation. A real qualification must separately verify the exact local
Hermes version, the structured 0.21 output, and the controlled launch policy.
The CLI documentation notes that one-shot operation can bypass Hermes approval
prompts, so Control Room must not send unrestricted tasks through it. The
qualification must prove a restrictive, Control-Room-owned task policy before
automatic dispatch is enabled. If the first start call loses its reply, Control
Room must mark that task uncertain; it must not retry and risk duplicate work.

No local listener, background service, credential access, or configuration
change is created by this code.

## Next activation step

An owner-attended Mac qualification supplies the private port and performs one
bounded text-only check before any real task is sent. The launcher is ready
locally and can first be inspected without contacting Hermes:

```sh
npx --yes pnpm@11.19.0 run qualify:hermes:local -- --owner-attended --dry-run
```

The real command removes `--dry-run`. It starts one temporary Hermes process
with the `bot_room` text-only toolset, one turn, and a two-minute limit. It
prints only a sanitized result: pass/fail, safe token counts, elapsed time,
and a hashed session reference. It deletes its own temporary directory after
the check. It does not install anything, change Hermes configuration, create a
listener, or start a persistent service.

Once that evidence is accepted, the normal task dispatcher can use the local
port for the same worker lifecycle used by remote Hermes workers. Source now
includes a dispatch-preparation step that reads the existing assigned task,
active lease, and pinned V5/V6 Hermes plan together, then creates the shared
delivery packet. It does not create a second queue or start Hermes itself.

## Normal automatic work

The source package now has `runAdmittedHermes021MacosLocalTaskV1`. It accepts
only the shared Control Room delivery packet and requires an
installation-owned policy to approve that exact packet before calling the
private Hermes runner. The policy keeps the local workspace, model selection,
login, and provider details private; a browser request or task prompt cannot
provide or widen them.

`createHermes021MacosLocalTaskPolicyV1` creates the policy record from an
already-authoritative task decision. It checks the selected Marvin worker,
the pinned Hermes revision, the controller's existing authority digest, and
the expiry. It is not a second approval system: it cannot authorize a task
that Control Room did not already authorize.

This is a controlled launch seam, not a background service. The source host
composition already joins the prepared packet to the delivery composition,
but a real installation still needs to configure its restricted task policy
and complete the text-only qualification first. A policy refusal starts no
Hermes task. A lost reply is recorded as uncertain and is never automatically
run a second time.

Before enabling this worker, the installation also registers the pinned
Hermes local adapter in Control Room's existing adapter registry. That is the
same neutral registry entry used by the durable-result checker to confirm
which adapter admitted a run. It contains no login, model, provider, file
path, or shell command. Creating that operator configuration is later gated
installation work; the worker code does not create it silently.

Before that controlled handoff, Control Room creates its ordinary harness-run
record. It binds Marvin's run to the assigned task, attempt, approved authority
and connector profile, while keeping local model, login, provider and workspace
details private.

Before the controlled runner is called, the shared local delivery composition
stores Marvin's accepted delivery receipt in Control Room's one database. If
the controller restarts after that point, it reports the task as already
delivered instead of silently starting Hermes again. That protects against
duplicate work; a person can later reconcile an uncertain prior result through
the normal result and review records.

The completed-record publisher accepts only a schema-checked terminal record
with its matching fingerprint and then creates Control Room's ordinary
pending-review item. The normal in-process handoff now wires that publisher to
the controlled runner. Its project, task, authority, review profile and
workflow details come from the controller-prepared packet—not from terminal
text or the browser. A completed Marvin record is evidence, not an approval:
it cannot release a task slot, retry an uncertain run, or accept the work on
its own.

The installed private runner now has a terminal-stage callback. It must save
the one schema-checked terminal Hermes line through that callback as it reads
the line, before returning control to Control Room. The staged bytes use the
same protected local result storage and are tied to the existing accepted
delivery; they are not a second queue, approval, or database. After a restart,
Control Room can read only that exact staged line and send it through the
ordinary result-and-review path without launching Hermes again. The runner
wiring and a real restart proof are still required before this is enabled.

`createHermes021MacosStreamJsonPrivatePortV1` is the source-level bridge for
that runner wiring. The installation can use
`createHermes021MacosSubprocessStreamJsonHostV1` as its narrow process wrapper.
It has a fixed Hermes executable and fixed argument layout, passes the approved
task only in a private temporary file, closes standard input, limits output and
runtime, and removes that temporary file after the process closes. It receives
the operator's already-selected profile, model, provider and safe work folder
only in private startup configuration; none are stored in a task, browser page,
or worker message.

This wrapper is not enabled automatically. The installer must still choose the
restricted work folder, register the worker, assemble the existing task policy,
and provide the resulting callback to the ordinary queue worker. That keeps a
browser request from choosing a model, profile, command, path, or tool access.
If the process ends without one valid terminal result, Control Room reports an
uncertain or failed task and never launches it a second time automatically.

The normal operator configuration assembly can now carry that
installation-owned local executor into the existing task queue. This is the
same startup path used for other workers, not a separate local launcher. It
requires the ordinary queue, reviewed result handling, protected artifact
storage, and an explicit queue-worker setting. It does not require a remote
session transport. The assembly captures only the executor callback; it never
accepts a Hermes command, credentials, model, provider, workspace, or any
browser setting.
