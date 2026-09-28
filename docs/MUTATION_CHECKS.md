# Mutation checks

Mutation checks prove that a test actually catches a guard being weakened. A pull request that
adds or changes a guard commits `mutation-checks/<branch-name>.json`, with `/` in the branch name
replaced by `-`. For example, `feature/owner-refusal` uses
`mutation-checks/feature-owner-refusal.json`.

Each entry first runs its test command on the unmodified checkout and requires it to pass. It then
makes one literal replacement and requires the same command to fail. The verifier rejects a
replacement unless `find` occurs exactly once. It restores the file after every command, including
timeout, SIGINT, and SIGTERM, and fails if the checkout is dirty before or after the run.

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
- `replace`: the weakened text, which may be empty to delete `find`, and must differ from `find`.
- `test`: a shell command that must pass on the baseline and then return a non-infrastructure
  nonzero result or terminate on a signal after mutation. Exits 126 and 127 are configuration
  errors, never evidence that a mutation was caught.
- `why`: a short human-readable name for the guard and its consequence.

Run the same check locally from a clean checkout:

```sh
node scripts/ci/verify-mutation-checks.mjs mutation-checks/feature-owner-refusal.json
```

An exit code of zero from a mutated `test` means the mutation survived and fails the job. A
nonzero exit is reported as an expected test failure unless it is 126 or 127. Termination by a
signal is also caught, but is reported separately as a crash so reviewers can distinguish it from
an assertion failure. Each baseline and mutated command has a 10-minute timeout by default; set
`MUTATION_CHECK_TIMEOUT_MS` to a positive millisecond value to override it. A timeout fails the
check and restores the file.

## CI behavior and security boundary

The **Mutation checks** job derives the manifest name from the pull request head branch. It only
installs dependencies and invokes the mutation verifier when that exact file exists. Manifests
must be regular files directly inside the top-level `mutation-checks/` directory; symbolic links
are refused. A path passed to the verifier outside that directory is ignored.

When no manifest exists, CI examines added and removed lines under `src/**`, `db/migrations/**`,
and `db/roles/**`. It emits a warning, not a failure, for source refusal words or uppercase SQL
`GRANT`, `REVOKE`, `SECURITY DEFINER`, `POLICY`, and `TRIGGER` markers. This is deliberately a
reminder rather than a parser; it can miss guards with different wording and can warn on comments.

Manifest test commands are repository code and run with the same network access and environment
as the rest of the pull-request CI job. The job uses the read-only pull-request permission, does
not persist checkout credentials, and does not pass any secrets or add network privileges. A
manifest must never rely on credentials, external services, or undeclared machine state.
