# Pull request claims and evidence

Pull requests that change `src/**` or `db/**` must include a `## Evidence`
section. Documentation-only pull requests may omit it. The CI job named
`PR evidence claims` checks the section against the pull request's head tree.

Write one claim per bullet, followed by one or more evidence lines:

````markdown
## Evidence

- The parser rejects an expired record.
  test: tests/record-parser.test.ts::rejects an expired record
- The complete integration lane covers the change.
  ci: Server build tests
- The focused suite passes locally.
  cmd: node --test tests/record-parser.test.ts
  ```text
  # tests 4
  # pass 4
  # fail 0
  ```
````

Evidence forms have these meanings:

- `test: <file>::<name>` resolves only when a `.test.*` or `.spec.*` file exists
  under `tests/` and contains that exact `test`, `it`, or `describe` name.
- `ci: <job name>` accepts a job ID or displayed job name in
  `.github/workflows/ci.yml`.
- `cmd: <command>` requires the command's actual output in a nonempty fenced
  block in the same bullet.

The check fails closed when the event payload, changed-path diff, evidence
shape, or reference cannot be read. PR bodies larger than 64 KiB are rejected.
It never prints PR-body content or referenced values; diagnostics contain only
fixed error codes and counts. The existing private-name redactor is applied to
those codes as a second safety layer.

Words such as `all`, `zero`, `never`, and `guaranteed` are treated as absolute
claims. CI emits a warning when a paragraph or bullet containing one has no
evidence line. Prefer a narrower statement that says exactly what the cited
test, job, or command established.
