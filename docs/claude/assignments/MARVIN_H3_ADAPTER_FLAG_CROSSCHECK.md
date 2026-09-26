# Marvin H3: Hermes and Claude CLI flag cross-check (P3), read-only

## Run these (help and version only; no prompts, no model calls)
- `hermes --help`
- `hermes --version`
- The Claude CLI with `--help` and `--version`. Its absolute path is given by the lead.

## Report
Confirm the exact spelling of each flag below and say whether it exists.

**Claude:**
- `-p`
- `--output-format stream-json`
- `--verbose`
- `--input-format text`
- `--tools ""`
- `--strict-mcp-config`
- `--setting-sources ""`
- `--no-session-persistence`
- `--permission-mode`
- `--max-budget-usd`
- `--disable-slash-commands`

**Hermes:** find the flags that do each of the following:
- disable all toolsets
- print one answer non-interactively
- avoid resuming a session
- select the `cr` profile

For each flag, quote the one-line help text. Keep the report to 40 lines or fewer. Do not print environment variables or secrets.
