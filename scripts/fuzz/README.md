# Seeded parser regression lane

Run `CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 pnpm test:fuzz:quick` for all 47
parser targets, 1,000 cases each, seed 20261002. `test:contracts` runs the
permanent F1–F12 regressions and this quick lane. No agent CLI or PostgreSQL
is used; HTTP stores and connector replies are recording fakes.

For a longer run:

```sh
CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 node --import tsx scripts/fuzz/run.mjs --seed 20261002 --cases 20000
```

Use `--target module-bundle` (or comma-separated names) to narrow a run.
Each target runs in a worker thread with a 512 MiB heap ceiling. The parent
terminates the worker in `finally`; a synchronous markdown case has a one-second
hard deadline. Other cases have an eight-second deadline. Every target must
finish every requested case; failures, corpus failures, leaks, bypasses and
hangs return a nonzero exit status. HTTP packet fixtures use short transport
deadlines for incomplete requests, which are expected refusals by Node's HTTP
server. The fuzzer opens only ephemeral loopback sockets and closes them in
teardown. Signed-directory fixtures use a per-process directory under `.qa/fuzzfix`
and remove it in teardown.

The portable JSON surface is the regression gate. Only the report's F13 parser targets retain non-JSON host exception diagnostics
(Proxy, Symbol, functions and null-prototype objects) in `exoticCrashKinds`; those exception types are
outside F1–F12. Wire bytes and missing optional fixture fields never exempt
transport failures. MCP Proxy exceptions, exotic bypasses, leaks and hangs still fail. The permanent MCP
regressions explicitly require typed refusals for Proxy replies.

Declarative module markdown/text is limited to 8 KiB per file and 16 KiB total
per bundle before parsing. Oversized files use the existing
`module_bundle_declarative_file_executable_content` refusal. Larger text must
be reduced or split within the total limit. JSON and trusted code bundle file
ceilings retain their existing limits.

The structure-aware generators and fixtures originated in the seed 20261002
hardening fuzz run. Permanent tests replay the two original markdown hang cases
and exercise the minimized finding shapes with independent expected outcomes.
