# Windows portability test fixtures

Fixtures for `tests/windows-*.test.mjs` are created at runtime via
`mkdtempSync(join(tmpdir(), "windows-*"))` and removed in `finally`
(`rmSync(... { recursive: true, force: true })`). Nothing is committed here.

If a future test needs a shared fixture, add it under a sub-directory named
`<purpose>-fixture/` and reference it from the test file via `process.cwd()`
+ relative path. Cleanup remains the test's responsibility.
