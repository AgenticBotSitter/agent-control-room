Raw captures from Stage A0 verification (see ../CLAUDE_CODE_A0_VERIFICATION.md).

- `cli-help-2.1.270.txt` — full `claude --help` output, version 2.1.270.
- `stream-json-unauthenticated.jsonl` — real `--output-format stream-json --verbose` output,
  captured unauthenticated (no login, no API key, total_cost_usd: 0). Three lines: system/init,
  assistant (auth error), result.

Captured 2026-09-13 on darwin-arm64, npm-global install method, no credentials entered.
