# Usage and cost evidence

Control Room records the model, effort, reported input/output tokens, and measured wall time for local CLI runs. It never turns an executor's estimate or a public price page into a billed cost.

Cost is calculated only when the owner records a protected `usage-prices.json` file beside the Mac-local protected configuration. The task and project views show that table's ID and recording time. If the file, model, token counts, or matching entry is absent, the UI says **cost unknown** and gives the reason.

Example:

```json
{
  "schema": "control-room.usage-price-table/v1",
  "tableId": "owner-prices-2026-09",
  "recordedAt": "2026-09-28T00:00:00.000Z",
  "entries": [
    {
      "entryId": "flat-plan",
      "harness": "claude",
      "model": "sonnet",
      "billing": { "kind": "subscription" }
    },
    {
      "entryId": "metered-model",
      "harness": "codex",
      "model": "example-model",
      "billing": {
        "kind": "token",
        "inputNanoUsdPerToken": "1250",
        "outputNanoUsdPerToken": "10000"
      }
    }
  ]
}
```

Token prices use integer nano-USD per token (one nano-USD is one billionth of a US dollar). This keeps every run and rollup exact. A subscription entry displays **included in subscription** and never invents a per-token cost.

The file must be a regular owner-owned file with no group or world permissions. A missing file is valid and leaves costs unknown; an unsafe or malformed file stops startup rather than silently ignoring recorded billing facts.
