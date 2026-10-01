#!/bin/sh
# A fake `codex` executable for tests that must drive the REAL bundled harness
# adapter.
#
# Why this exists: a released connector bundle registers the reviewed harness
# factory (`registerBundledHarnessAdapterFactory`), and that factory
# deliberately ignores a machine's `adapterModule` setting and drives the real
# local CLI instead. Source-mode tests keep the `adapterModule` seam; a test
# that installs a real signed bundle cannot, so it needs an executable that
# speaks Codex's `exec --json` JSONL contract on stdout.
#
# It is a POSIX `sh` script, NOT a node script, on purpose. The runner spawns
# the CLI with a pinned environment -- `PATH=/usr/bin:/bin` and nothing else --
# so a `#!/usr/bin/env node` shebang fails with ENOENT on any machine whose
# node is installed outside those two directories. This script needs only /bin/sh.
#
# It is deterministic: it consumes the prompt on stdin, echoes one result
# message and the completion frame the runner requires, then exits 0. When
# FAKE_CODEX_ARGV_LOG names a writable path it records its argv there, so a test
# can assert how the real adapter invoked it.
#
# Contract it satisfies (src/harness/codex-v1/owner-trusted-local-exec.ts):
#   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
#   {"type":"turn.completed","usage":{...}}
prompt=$(cat 2>/dev/null || true)
if [ -n "${FAKE_CODEX_ARGV_LOG:-}" ]; then
  printf '%s' "$*" > "$FAKE_CODEX_ARGV_LOG" 2>/dev/null || true
fi
text=${FAKE_CODEX_TEXT:-"fake codex did the work: $(printf '%s' "$prompt" | tr '\n' ' ' | cut -c1-200)"}
# The text is JSON-escaped by construction: everything that could need escaping
# (quotes, backslashes, control characters) is removed from the echo.
text=$(printf '%s' "$text" | tr -d '\\"')
printf '{"type":"item.completed","item":{"type":"agent_message","text":"%s"}}\n' "$text"
printf '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n'
exit 0
