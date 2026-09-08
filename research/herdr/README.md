# Herdr evaluation prototype (not production)

See [the result and scope](../../docs/research/HERDR_ADAPTER_EVALUATION.md).
No package dependency, application registration, worker, server autostart or CI
workflow is added. The prototype is original adapter code using Herdr's public
CLI/JSON interface; upstream source remains external and pinned in the report.

Effect-free contract tests:

```text
node --test research/herdr/monitor.test.mjs
pnpm exec eslint research/herdr/*.mjs
pnpm check
```

The following commands are **explicit acquisition/runtime operations**, not routine
tests. Do not execute without scoped approval and the logged pinned download root:

```text
node research/herdr/license-inventory.mjs /private/tmp/control-room-herdr-eval.REPLACE
node research/herdr/binary-evaluation.mjs /private/tmp/control-room-herdr-eval.REPLACE
```

The metadata script performs bounded public crates.io reads without installing
packages. The binary evaluation verifies the exact Mac v0.9.0 checksum, starts
temporary local-socket servers with cat panes, writes only disposable fixture state,
reports fake sessions, checks recovery and shuts down owned processes. It never
starts Hermes/Codex, reads personal profiles, uses SSH, or calls a provider.
The observer itself invokes only `pane list`; fixture setup has broader access
solely to its disposable server. No modified upstream runtime is used.

Failed test roots retain private diagnostics; successful roots are removed after
shutdown. Parent downloads and normalized evidence have separate disposition in
the download ledger. Never target a user's running Herdr socket with the fixture.
