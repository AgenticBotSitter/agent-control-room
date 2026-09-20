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
port for the same worker lifecycle used by remote Hermes workers.

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

This is a controlled launch seam, not a background service. A real automatic
host still needs the operator to configure its restricted task policy and
complete the text-only qualification first. A policy refusal starts no Hermes
task. A lost reply is recorded as uncertain and is never automatically run a
second time.

Before the controlled runner is called, the shared local delivery composition
stores Marvin's accepted delivery receipt in Control Room's one database. If
the controller restarts after that point, it reports the task as already
delivered instead of silently starting Hermes again. That protects against
duplicate work; a person can later reconcile an uncertain prior result through
the normal result and review records.
