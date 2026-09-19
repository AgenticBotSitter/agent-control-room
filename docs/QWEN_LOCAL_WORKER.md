# Local Qwen worker for Control Room

This is a read-only local helper for delegating large inspection and drafting tasks to the
Mac's existing `qwen3.8:27b-long` Ollama model. Codex remains responsible for architecture,
security, final review, GitHub actions and integration.

## Why this path exists

Codex multi-agent messages currently reach the local model as an unreadable protected payload.
The standalone Codex OSS agent loop also failed to return a trivial response. Direct Ollama chat
works reliably when it uses the settings already qualified for Hermes:

- `qwen3.8:27b-long`
- 131,072-token context
- at least 4,096 output tokens for substantial work
- streaming responses
- `/api/chat`, not `/api/generate`
- explicit `/no_think` plus the empty thinking prefill for bounded routine work

The helper fails rather than silently accepting an empty answer, an output-budget exhaustion or a
reasoning block leaked into the deliverable.

Input is capped at 128 KiB (approximately 32,000 source tokens). Larger reviews must be filtered
and divided by code path. This reduces latency and avoids losing important code in an oversized
prompt even though the model itself supports a larger context window.

## Run it

Small task:

```bash
node local-tools/qwen-worker.mjs --task "Reply with exactly: QWEN READY"
```

Hard review, using two visible direct-answer passes rather than unbounded hidden thinking:

```bash
git diff --no-ext-diff --binary origin/main...HEAD | \
  node local-tools/qwen-worker.mjs --mode deliberate \
  --task "Review this patch for concrete correctness defects. Cite exact failure paths."
```

Review the current diff:

```bash
git diff --no-ext-diff --binary origin/main...HEAD | \
  node local-tools/qwen-worker.mjs --task "Review this patch for concrete correctness defects. Cite changed files and failure paths."
```

The command emits one JSON result containing the answer, model, wall time, prompt/output token
counts, pass metrics and measured generation speed. `direct` makes one pass. `deliberate` makes a
second pass that audits and corrects the first answer. It makes no repository, GitHub, credential
or production change.

Do not enlarge the current 131,072-token context for this worker. Focused inputs are capped near
32,000 tokens, and the installed model already occupies about 28 GB while loaded. More context
would reduce the Mac's safety margin without improving these bounded jobs. Do not use the model's
unbounded thinking modes here: live tests showed they can consume the output budget without a
deliverable. Use `deliberate` for harder work instead.

## Appropriate work

- first-pass pull-request review;
- code-path and test-gap mapping;
- issue and work-packet drafts;
- documentation drafts;
- bounded implementation planning;
- analysis of test failures.

Do not use it as final authority for security, permissions, migrations, production effects,
architecture or merges. Codex verifies material findings instead of repeating the entire analysis.

## Initial quality evidence

Two blind historical reviews were run against public Control Room submissions whose later defects
were already known:

1. Contributor-demo acceptance harness: Qwen independently found the login-code leak and both
   cleanup-evidence failures. It also found one additional plausible cleanup gap. It did not cleanly
   isolate the known lost-response defect in its final truncated answer.
2. Schedule-inspection patch: Qwen found the unauthorized stylesheet change and the keyboard test
   that manually clicked after dispatching Enter. It missed the timezone-label defect and accepted
   an insufficient stale-response test.

Conclusion: Qwen is valuable for high-volume first-pass review and can reduce paid model reading,
but it is not a substitute for final Codex review. Track its findings, misses, false positives,
elapsed time and output tokens on real work before expanding its authority.
