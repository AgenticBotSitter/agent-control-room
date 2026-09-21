# Local Hermes worker: later installation step

This is the next **owner-approved setup step** after the source code and
text-only qualification are accepted. It is not a command to run yet, and it
does not enable the worker by itself.

## What Control Room now provides

Control Room can create a narrow local process wrapper for Hermes 0.21. It:

- uses one owner-pinned absolute Hermes program path, never a command supplied
  by a task or web page;
- uses the operator's existing Hermes profile and selected model/provider;
- puts task text in a permission-restricted temporary file rather than the
  command line;
- closes standard input, sets a maximum runtime and output size, and deletes
  temporary task material when the process ends;
- sends only structured result lines into the existing Control Room result and
  review process.

It does **not** store a Hermes login, API key, local folder, selected model,
or provider in Control Room records. It does not start a background service.

The successful text-only check can be reduced to an opaque proof fingerprint
for the setup page. That confirms the check passed without putting its session
reference, token counts, command, or selected model on the page.

Trusted installation code can use the source helper
`recordHermes021MacosLocalQualificationReadinessV1` to update that one setup
item while preserving the plan's other requirements, such as backup/restore.
It is a pure server-side helper; it does not write settings, enable the worker,
or accept a browser upload.

For an installer that already holds only the sanitized report and its reviewed
setup plan, `record:hermes:local-readiness` provides the same pure conversion.
It reads JSON files and prints an opaque readiness record; it never writes the
record, starts Hermes, or prints the file names or their private contents.
The protected installer decides whether and where to retain that record.

That first check is intentionally not treated as proof of the automatic route.
After it passes, the owner separately runs the fixed-runner bridge check. Its
report is reduced to another opaque fingerprint through
`recordHermes021MacosLocalRunnerQualificationReadinessV1`. This proves the
same controlled runner that would receive a Control Room task can reach the
existing Hermes installation, without keeping the selected path, profile,
model, provider, task text, or response.

Before that owner-attended check, the effect-free
`preflight:hermes:local-runner` command can verify the selected program and
work folder without starting Hermes or contacting a model. It uses the exact
same settings shape as the bridge, so it catches an unusable local path before
the one permitted live check is spent.

Both the preflight and the one-shot bridge check also ask that already-selected
program for its public `--version` response. They refuse a version or upstream
revision other than the pinned Hermes 0.21.3 source identity. The command does
not return, save, or display the selected program path, profile, model,
provider, workspace, or the rest of the version output.

## What still needs an owner decision

Before a real automatic task can be enabled, the owner chooses:

1. The Hermes profile that will be used for Control Room work.
2. One safe work folder that Hermes may use for those tasks.
3. The local model/provider fallback policy.
4. The first restricted task policy: what kinds of task it may receive and
   whether tools are allowed.

Control Room then creates one worker registration and one private startup
configuration. The application still has one task queue, one review process,
and one database; this is not a separate local system.

The startup configuration refuses to activate the local Hermes callback until
the reviewed setup plan records all three local prerequisites: the text-only
agent check, the fixed-runner bridge check, and the disposable backup/restore
proof. Adding a future remote worker does not make the local callback wait for
that remote worker's separate proof.

## Safety rule for the first live task

The first real task should be a small, harmless text task chosen by the owner.
If Hermes starts but its answer cannot be confirmed, Control Room marks it as
uncertain. It does not automatically rerun it, because a second run could do
the work twice.
