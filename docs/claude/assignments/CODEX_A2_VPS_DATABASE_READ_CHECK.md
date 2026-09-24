# Codex A2: read-only Mac→VPS database check command (P1)

Plan: `docs/MAC_LOCAL_CRITICAL_PATH.md`. You are a bounded worker. Your output is evidence.

## Branch and files
- Base your work on `claude/mac-local-integration`. Work on branch `codex/mac-local-a2-db-check`.
- Create **only** these files:
  - `scripts/check-mac-vps-database.ts`
  - `tests/check-mac-vps-database.test.ts`
  - a `package.json` script entry named `check:database:vps`

## Build
A command the owner runs from Terminal.

**Configuration:**
- It takes one absolute path to an owner-only (mode 0600) JSON file.
- The file holds the connection settings for each component role, in the shape `validatePrivatePostgresConfiguration` expects.
- The command never prints any field value from that file.

**Checks, for each role:**
- Validate the settings with `validatePrivatePostgresConfiguration`.
- Reuse `checkPrivateWebDatabase` / `createPrivateWebDatabaseCheck` from `src/web/v1/private-startup.ts` for the web role.
- For the other roles, connect read-only and confirm:
  - the TLS peer is verified
  - the role name matches
  - `SELECT 1` succeeds
  - the migration ledger matches `deploy/postgres/migration-ledger.json`

**Output:**
- One line per role: `ok` or the refusal code.
- Exit code 0 only when every role is ok.

**Limits:**
- No writes, migrations, retries, or logging of secrets.

## Tests
- Use injected fake database openers only.
- Include cases for: file mode refusal, a bad field, a secret never appearing in output, and a ledger mismatch.

## Verify
- The test file passes.
- `pnpm check`
- `git diff --check`

## Forbidden
- Connecting to the real VPS, credentials, pushing, or merging.
