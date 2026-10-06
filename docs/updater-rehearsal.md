# Updater fault-injection rehearsal

The item-25 harness runs the section-13 acceptance inventory without treating an unavailable dependency as green. Each
P-case contains granular scripted scenarios. A runnable scenario is `pass` or `fail`; a scenario owned by a later item is
`pending: needs item X`. A P-case remains `pending` while any of its scenarios is pending.

For a no-sudo local run, copy `config/updater-rehearsal.throwaway.example.json`, choose a new absolute root named
`control-room-rehearsal-*` below `/private/tmp`, and run:

```sh
pnpm updater:rehearsal --config config/updater-rehearsal.throwaway.example.json
```

The harness creates fake `launchctl`, `sudo`, `tailscale`, and `diskutil` commands inside that disposable root. It never
uses those command names from the ambient path. Instrumented `pbcopy` and `pbpaste` fakes make clipboard use observable
without touching the machine clipboard. Evidence is written below `<rehearsalRoot>/evidence/<run-id>/`. The same marked
root is reusable: each run gets a distinct evidence directory and the fake commands are replaced safely. Concurrent runs
against one root refuse with `rehearsal_root_busy`.

Keep `TMPDIR` below `/private/tmp` when running the full updater lane on macOS. A home-directory `TMPDIR` below `/Users`
is intentionally refused by the trusted-runtime profile builder, because service executables from owner-writable roots
are outside the production trust boundary.

Real-root mode requires all of the following before scenario execution:

- effective uid 0;
- an explicit `mode: "real-root"` configuration with `allowRealRoot: true`;
- a subdirectory below `/Volumes/CRRehearsal` (the volume root itself is refused);
- `diskutil info` reporting `Owners: Enabled`;
- a hostname containing `rehearsal`, an exact expected origin including the web port, three distinct non-live ports,
  three distinct rehearsal account names, and a rehearsal-only daemon label prefix.

Use `config/updater-rehearsal.real-root.example.json` as the shape, after the dedicated image has been attached with
owners enabled and the separate rehearsal hostname exists. The harness refuses the live install root and the known live
or preview ports before it writes a run directory.

Every scenario directory contains `result.json`, `journal.jsonl`, `links.json`, and `status.json`. The run root contains
`summary.json` and the single Markdown summary table in `summary.md`. A runnable implementation cannot pass unless it
returns structured evidence with a positive assertion count; a missing implementation, `{}` no-op, or zero-assertion
result is recorded as a failed scenario.
