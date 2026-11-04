# b5-start-digest-schema findings

- Starting HEAD (task-document commit): 061a1055b456e3b8a23159d56b7690493241ff3a
- Implementation base (HEAD^): 9a8a5491da9b9dff1b47ef2486c6a2ccfdda61b3 (cook/b5-first-website)
- Output branch: cloud/b5-start-digest-schema (no PR, no merge)
- Node v22.23.4; dependencies from the repo's pnpm lockfile (`pnpm install --frozen-lockfile`, exit 0). No native PostgreSQL, no PG_BIN, no PGlite body selected.

## Change (test-local only)

`tests/improve-control-room-first-website-controller-postgres.test.ts`:

- `readControllerStartDigests` no longer casts. A zod schema requires `authorizationSha256`, `settings`, `availability`,
  `qualification`, `assembly`, `faultInput`, `reviewInput` (each `sha256:` + 64 lowercase hex), keeps the digest-only
  `catchall` for extra commitments (for example `transport`), rejects a wire key named `authorization` (it would collide with the
  mapped internal name), and transforms `authorizationSha256` back to `authorization`. The return type is inferred
  (`z.output<typeof schema>`); a compile-time assignability helper checks it against `B5QualifiedPinsV1["digests"]`.
- New tests (all named `B5 controller-start consumer ...`):
  - complete seven-key and optional-transport positives: exact key set, `strictEqual` per value against the wire input,
    byte equality, no `authorizationSha256` leaked, input JSON and deep-clone unchanged;
  - one test per required key deleting it independently (7 tests);
  - malformed values for all 7 required keys and `transport`: undefined, null, number, boolean, object, array, empty, short,
    long, uppercase hex, uppercase prefix, non-hex, missing prefix, surrounding whitespace, trailing newline (8 x 18 cases),
    plus non-object inputs;
  - internal `authorization` name alone and alongside `authorizationSha256`.
  - Every rejection requires `z.ZodError` and exact input immutability (JSON bytes and deep equality).
- Production evidence output and the native PG gate are unchanged.

## Commands and results

Focused command: `env CONTROL_ROOM_TEST_BLOCK_AGENT_CLI=1 NODE_ENV=test TMPDIR=/tmp node scripts/run-tests-with-quarantine.mjs --import tsx --test --test-concurrency=1 --test-timeout=600000 --test-name-pattern='^B5 controller-start consumer' tests/improve-control-room-first-website-controller-postgres.test.ts`

| Step | Exit | Time | tests/pass/fail/skipped/cancelled |
|---|---|---|---|
| Baseline focused (original file) | 0 | ~1s | 1/1/0/0/0 |
| Red: new tests vs original reader | 1 (expected) | ~1s | 12/5/7/0/0 |
| Green: focused after fix | 0 | ~1s | 12/12/0/0/0 |
| Mutation control (copied graph) | 1 (expected) | ~1s | 12/10/2/0/0 |
| Broader (`controller-start consumer`, `browser intake`, `request poll`) | 0 | ~1s | 16/16/0/0/0 |
| `tsc --project tsconfig.vps.json --noEmit` | 0 | 39s | n/a (production-only check) |
| Extra: tsc on the edited test file via a temporary tsconfig extending `tsconfig.json` (in `.test-tmp/`, removed) | 0 | 23s | 0 diagnostics |

Red details: the six deletion tests for `settings`, `availability`, `qualification`, `assembly`, `faultInput`, `reviewInput`
each failed with `Missing expected exception (ZodError).`; the `authorization`-collision test also failed that way. The
`authorizationSha256` deletion and malformed-value tests already passed with the original reader (its `catchall` validated
present values only).

Mutation control: the test file was copied into `.test-tmp/mut-*/tests/` (other top-level entries and test helpers symlinked
to the real checkout); the single anchor ` settings: b5StartDigestV1,` (exactly one match) was changed to
`.optional()`. The matching deletion vector `rejects a missing settings pin` failed with `Missing expected exception (ZodError).`;
the malformed-value test also failed (the `undefined` value for `settings` was accepted). The real file's sha256 was
verified unchanged; the copy was removed by trap and the real source was re-run green (broader run above).

All selected bodies executed (non-zero test counts, every named test reported `ok`). No native body ran.

## Cleanup and limitations

- `.test-tmp/` is empty after the run; no child processes, listeners or servers were started beyond the node test runner.
- Private-name guard runs without a configured list (explicit SKIP); the lead must run the configured privacy CI.
- TypeScript's VPS project excludes tests; the extra targeted typecheck covered the edited file.

## Scans

- Secret scan on the two changed files: `RESULT secret-scan files=2 findings=0` (exit 0).
- Private-name guard: `private-name check skipped: no list configured` (exit 0, SKIP).
- `git diff --check`: exit 0. `git status --short`: only the two allowlisted paths.
