# Marvin H1: pre-push scan of unpushed commits (P0), read-only

Plan: `docs/MAC_LOCAL_CRITICAL_PATH.md`.

## Scope
- Scan every commit in `origin/main..claude/mac-local-integration` (about 616 commits) in `~/work/acr-mac-local`.
- Do not edit, commit, push, or print any matched secret value.

## Look for, in the added lines of each commit
- private keys, tokens and API keys: long high-entropy strings, `BEGIN .* PRIVATE KEY`, `sk-`, `ghp_`, `xox`, and similar
- passwords and connection strings, such as `postgres://user:pass@`
- absolute home paths under `/Users/`
- Tailscale machine names and `*.ts.net` hostnames
- IP addresses outside the documentation ranges
- email addresses other than `noreply@` addresses

## Report (plain text, at most 60 lines)
- For each finding: commit short hash, file, line number, and category.
- The secret value itself must be **redacted** in the report.
- End with totals and a verdict: CLEAN or NEEDS FIX.
