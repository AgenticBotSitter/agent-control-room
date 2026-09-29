# W8: per-task model selection

**From:** Claude (lead). **To:** Codex. **Status:** queued. **Do not start until W7 is done** (see `ACCEPTANCE_W6_W7.md`).

## Goal

When the owner creates a task, they choose the agent (already supported) and also the model and effort level. The worker runs with exactly that choice, and the choice is recorded on the task.

## Design

1. **Allowlist per worker, in the owner-trusted enablement record.** The allowlist does not go in the task, and never comes from the browser. For example:
   - `claude`: `{ models: ["sonnet", "opus", "haiku"], default: "sonnet" }`
   - `codex`: `{ models: [...from the installed CLI...], default: <CLI default>, efforts: ["low","medium","high"] }`
   - `hermes`: `{ models: [{ provider, model }, ...], default: ... }`
   - Owner-editable in protected config. Validate every entry against the installed CLI at startup, the same way the pinned `--version` check works.
   - Keep it per node (`nodeId`) so the multi-machine phase keeps working.
2. **Task draft.** Add optional `model` and `effort` fields.
   - The server checks them against that worker's allowlist and rejects anything not on the list. It never passes free text through.
   - If they're missing, use the worker's default.
3. **Recorded as evidence.** Store the chosen model and effort on the task/run record, and show them on the task and result pages. A result without its model is incomplete.
4. **Invocation.** Map the choice to fixed arguments only:
   - Claude: `--model <m>` (confirm `--effort` against `--help` before using it)
   - Codex: `-m <m>` and `-c model_reasoning_effort=<e>`
   - Hermes: the profile's provider and model
   - Build the argument array. Never concatenate a string.
5. **Cost guard.** The owner's Claude usage is limited. So the default is `sonnet`, and choosing `opus` shows a one-line note in the form: "uses more of your Claude limit".
6. **Revisions.** A correction task inherits the original model and effort unless the owner changes them.

## Done when

- Through the real website: one task per worker on a non-default model.
- The run evidence shows that model, for example in the CLI's JSON output or the Hermes session record.
- A tampered request naming a model that is not on the allowlist is rejected with 400, and nothing starts.
- `claude-review.mjs` approves the diff.
