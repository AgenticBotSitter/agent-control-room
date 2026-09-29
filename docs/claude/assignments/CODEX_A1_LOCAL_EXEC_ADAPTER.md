# Codex A1: owner-trusted local Codex exec adapter (P3)

Plan: `docs/MAC_LOCAL_CRITICAL_PATH.md`. Lead and integrator: Claude. You are a bounded worker. Your output is evidence and does not approve anything.

## Branch and files
- Base your work on `claude/mac-local-integration`. Work in your own worktree on branch `codex/mac-local-a1-codex-exec`.
- Create **only** these files:
  - `src/harness/codex-v1/owner-trusted-local-exec.ts`
  - `tests/codex-owner-trusted-local-exec.test.ts`
  - a fake executable under `tests/fixtures/`
- Do not edit composers, startup, `private-task-startup.ts`, or any shared delivery files.

## Build
A pure adapter that runs one text-only Codex task and returns the final text.

**Input:**
- the absolute executable path, from the caller
- the prompt text, at most 64 KiB
- a per-task working directory that already exists and is empty
- a deadline in milliseconds
- an `AbortSignal`

**Command it runs:**
- Fixed arguments: `exec --json --sandbox read-only --ephemeral --skip-git-repo-check --color never -C <cwd> -`
- The prompt goes to stdin once, then stdin is closed.
- No model or provider flags. The caller supplies no other arguments.

**Environment:**
- Allowlist only: `HOME`, `PATH` (a fixed system path), `LANG`, `TMPDIR`.
- Nothing else is inherited.

**Process handling:**
- Spawn in a new process group (`detached: true`).
- On abort or deadline, send TERM to the group, then KILL after 5 seconds, then reap.

**Output:**
- Parse stdout as JSONL. Reuse the parsing ideas in `read-jsonl.ts` and `start-jsonl.ts` where they fit.
- Return a frozen `{ status: "completed", text, usage? }` or `{ status: "failed" | "canceled" | "timed_out" | "cleanup_uncertain", reason }`.
- Cap output at 1 MiB. Refuse malformed frames. Never retry.

## Tests (fake executable only, never the real Codex)
- happy path
- the exact args and stdin are received
- no extra env vars leak
- malformed JSONL
- nonzero exit
- deadline kills a child that ignores TERM
- abort before spawn means no spawn

## Verify
- `node --import tsx --test tests/codex-owner-trusted-local-exec.test.ts`
- `pnpm check`
- `git diff --check`

## Forbidden
- Running the real Codex, network access, credentials, pushing, or merging.

## Report
Report: branch, commit, test output, and any open questions.
