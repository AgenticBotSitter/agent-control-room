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

## Safety rule for the first live task

The first real task should be a small, harmless text task chosen by the owner.
If Hermes starts but its answer cannot be confirmed, Control Room marks it as
uncertain. It does not automatically rerun it, because a second run could do
the work twice.
