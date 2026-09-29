# Public releases

Daily work stays in the private Control Room repository. When the owner decides that a weekly or monthly public update is useful, they prepare one clean public release from the chosen private integration ref.

`pnpm release:prepare` is read-only and uses no network commands. It calculates the next patch version with that day's date, turns the selected commit subjects into a plain-language `CHANGELOG.md` section, and prints an approval token. Before it prints that candidate, it runs the private-name guard using the private names file, a credential scan, both type checks, the migration-ledger check, and the test-lane coverage check. Any failed or missing gate stops the release.

The private names list never belongs in this repository. Keep it in the owner's private configuration and pass its file path:

```sh
pnpm release:prepare -- --source-ref cook/v1 --private-names-file /secure/private-names.txt
```

Copy the printed approval command only after reviewing the version, changelog, source commit, and gates. The token is bound to that exact source commit, date, version, and changelog; a changed source or date needs a new prepare run.

```sh
pnpm release:publish -- --source-ref cook/v1 --date 2026-09-29 --approval APPROVAL_TOKEN
```

By default, publish creates one local root commit on `release/vVERSION`, adds the matching annotated tag, and prints the exact `git push` and `gh release create` commands. It does not contact GitHub. It never rewrites `main` or force-pushes.

Only an owner who has reviewed the candidate may add `--push`; with the approval token this pushes the new branch and tag and creates the GitHub release. Do not use `--push` to retry an uncertain network result: inspect the remote branch and tag first.
