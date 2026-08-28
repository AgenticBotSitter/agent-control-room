# CR-7B macOS isolated qualification setup

**Status:** Static launcher plan and service templates implemented. No native deployment is authorized by this document.

## Goal

Prove that an authenticated Codex app-server can ask a separate credential-free `exec-server` to run commands without letting that executor read authentication, read or change the replay ledger, call the provider directly, or fall back to broker-local command execution.

This uses an experimental Codex app-server/remote-environment seam. Even if qualification succeeds, it remains disposable qualification evidence and is not production-approved.

## Required shape

```text
logged-in broker identity                    dedicated non-admin executor identity
  private credential root                      empty private CODEX_HOME
  separate private state/ledger                 isolated workspace
  Control Room broker controller                pinned codex exec-server
    child: codex app-server --stdio     ->        loopback WebSocket, one request
  exact provider egress                         provider egress blocked
```

The app-server channel is parent-owned stdin/stdout. The loopback WebSocket is only the remote command-executor connection. The executor is registered with `environment/add`, must report `ready`, and every thread or turn is explicitly given that nonempty environment selection. An omitted or empty environment selection is a failure because it could allow local execution.

## Stage 0 — repository-only conformance

This stage is effect-free and can run without native authorization.

1. Verify the pinned binary manifest and static service templates.
2. Generate a launcher plan from synthetic absolute paths and one loopback endpoint.
3. Confirm distinct identity digests and disjoint broker release, configuration, credential, and state roots plus executor home and workspace. The executor working root may contain only its workspace, never a broker-owned root.
4. Confirm the allowed client methods are limited to initialization, remote-environment registration/inspection, thread start/resume, turn start, and turn interruption. General process spawning, configuration writes, plugin installation, and MCP-server operations are forbidden.
5. Run the CR-7B tests, type check, lint, full suite, production build/render checks, and migration verification.

Passing Stage 0 means only that the plan and templates fail closed in code.

## Stage 1 — owner-approved host preparation

Stop and obtain exact owner approval before this stage. Record the approved paths, identity names, loopback port, pinned executable identity, time limit, and cleanup scope without committing raw host identity or paths.

The owner, from an attached Terminal, creates or confirms the dedicated non-admin executor identity and the planned private roots. The executor gets access only to its home and disposable workspace. It must be denied every broker-owned release, configuration, credential, and state root. Broker state owns the SQLite ledger; authentication remains in the broker credential boundary and is never copied.

Negative proof is required from the executor identity: broker credentials unreadable, ledger unreadable and unwritable, broker controller unsignalable/untraceable, and executor home free of saved authentication. A failed check stops the qualification.

## Stage 2 — owner-approved network and service preparation

Stop and obtain separate exact owner approval before rendering, writing, installing, or loading service files or changing network controls.

Render the static templates to an uncommitted host-local directory. Reject unresolved placeholders. Independently inspect the rendered files before installation. Then prove:

- the executor listens only on the selected `127.0.0.1` port;
- only the expected broker-side client can reach that endpoint;
- executor provider DNS/TCP/TLS egress is blocked;
- broker provider egress is restricted to the exact provider allowlist;
- the broker controller owns app-server stdin/stdout and exposes no app-server listener;
- service process identities and executable signature/version match the plan;
- remote disconnect fails the run and never selects local command execution.

Service readiness alone is not qualification. Retain only sanitized pass/fail codes and digests.

## Stage 3 — effect-free protocol rehearsal

The repository now exercises the controller with a fake app-server transport. It proves the required initialize handshake, exact `environment/add`, ready-status gating, explicit nonempty environment selection, atomic ledger claim before `turn/start`, one dispatch per request, bounded/correlated JSONL, content-free usage and terminal settlement, disconnect ambiguity, and rejection of server-initiated or non-allowlisted methods. It also tests the exact pinned child specification, ambient-environment exclusion, identity drift, fragmented/oversized/flooded child stdout, stderr exclusion, partial exit, exact close/terminate, deadline, and cancellation. Independent review remains required before Stage 4.

Any uncertainty after a claimed turn is terminally ambiguous. It must not be retried automatically.

## Stage 4 — separately authorized disposable native qualification

Stop and request a new exact owner approval naming the maximum provider calls, time limit, read-only workspace, cleanup targets, and retained sanitized evidence. Earlier approval has been consumed and does not carry forward.

The qualification must prove start, bounded events, usage, cancellation, and explicit-ID resume while continuously retaining the isolation proofs above. It must not enable workspace writes, MCP servers, plugins, deployments, or consequential effects. No prompt, response, command, path, credential, raw identity, or session identifier is retained.

## Failure and rollback

On any failure:

1. Stop dispatch and close the permit. Unsettled claimed calls become ambiguous.
2. Unload only the specifically approved disposable services.
3. Preserve the private ledger and sanitized evidence until review; do not delete credential or state roots as an improvised cleanup step.
4. Report a safe stage/reason code. Never include raw service output that could contain authentication, prompts, commands, paths, or host identity.
5. Return to architecture review. Do not weaken permissions, permit local fallback, broaden egress, copy credentials, or make a second attempt under the same claim.

Deleting identities, roots, ledger state, or installed files is a separate destructive action and requires exact owner approval.

## Acceptance boundary

CR-7B native qualification passes only after independent review confirms every OS/process/filesystem/network assertion plus sanitized lifecycle evidence. The experimental seam remains ineligible for production. Production requires a separately supported and reviewed transport boundary.
