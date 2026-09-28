# Mutation checks

Mutation checks prove that a test actually catches a guard being weakened. A pull request that
adds or changes a guard commits `mutation-checks/<branch-name>.json`, with `/` in the branch name
replaced by `-`. For example, `feature/owner-refusal` uses
`mutation-checks/feature-owner-refusal.json`.

Each entry makes one literal replacement, runs one test command, and requires that command to
fail. The verifier rejects a replacement unless `find` occurs exactly once. It restores the file
after every command, including a command terminated by a signal, and fails if the checkout is
dirty before or after the run.

```json
[
  {
    "file": "src/server/authorize-task.ts",
    "find": "if (!ownerCanRun) throw new TaskRefusal(\"not authorized\");",
    "replace": "if (false) throw new TaskRefusal(\"not authorized\");",
    "test": "node --import tsx --test tests/authorize-task.test.ts",
    "why": "a non-owner must not start the task"
  }
]
```

The fields are all required strings:

- `file`: a tracked regular file inside the checkout (symlinks are refused).
- `find`: the exact source text to weaken; it must occur once.
- `replace`: the weakened text, which must differ from `find`.
- `test`: a shell command that must return nonzero or terminate on a signal.
- `why`: a short human-readable name for the guard and its consequence.

Run the same check locally from a clean checkout:

```sh
node scripts/ci/verify-mutation-checks.mjs mutation-checks/feature-owner-refusal.json
```

An exit code of zero from `test` means the mutation survived and fails the job. A nonzero exit is
reported as an expected test failure. Termination by a signal is also caught, but is reported
separately as a crash so reviewers can distinguish it from an assertion failure.

## CI behavior and security boundary

The **Mutation checks** job derives the manifest name from the pull request head branch. It only
installs dependencies and invokes the mutation verifier when that exact file exists. A path passed
to the verifier outside the top-level `mutation-checks/` directory is ignored.

When no manifest exists, CI examines only added and removed lines under `src/**`. It emits a
warning, not a failure, if a changed line contains one of these simple, case-insensitive markers:
`authorize`, `refuse`, `forbid`, `throw new .*Refus`, `REVOKE`, `GRANT`, `CHECK (`, or
`SECURITY DEFINER`. This is deliberately a reminder rather than a parser; it can miss guards with
different wording and can warn on comments.

Manifest test commands are repository code and run with the same network access and environment
as the rest of the pull-request CI job. The job uses the read-only pull-request permission, does
not persist checkout credentials, and does not pass any secrets or add network privileges. A
manifest must never rely on credentials, external services, or undeclared machine state.
