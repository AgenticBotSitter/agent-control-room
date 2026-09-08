# Independent F2 Python router source/fit review

2026-09-08. Source-only review of report, both harnesses, acquisition/evidence receipts and actual `src/harness/codex-v1/isolated-jsonrpc.ts`. No downloads, executions, providers, services or application changes. Cleaned upstream sources are not available for independent byte-level rereading; upstream behavior is assessed through the retained harness/assertions and receipts, not presented as my independently executed finding.

## Finding

**P2 — listed hashes are verified, but the claimed namespace-only import boundary is not enforced by the reproduction harness.** `f2-router-fit.py` verifies each receipt-listed file, then prepends the download root to `sys.path` and performs ordinary package imports. It does not reject extra files, particularly `openai_codex/__init__.py` or `generated/__init__.py`, or verify the resulting imported modules' origins. The acquisition script also accepts an existing root. An extra package initializer can therefore execute despite every listed SHA matching, contradicting the intended omission of upstream package initialization. This is a reproduction-integrity gap, not evidence that the reported clean-root run imported an extra initializer.

Before another run, require the exact expected file set with no symlinks/initializers before importing, and check imported module origins against the verified root (or otherwise enforce equivalent isolated loading). Use explicit exceptions for pre-import identity checks rather than Python `assert`, which disappears under `-O`. The existing seven checks do genuinely compare pinned receipt hashes; the missing property is the complete executable import closure, not an absence of all pin verification.

## Boundaries and claims that are sound

- The report distinguishes a dependency-complete router subset from a full SDK package/client/transport. Namespace loading, actual generated Pydantic notifications and the unknown-notification path are specifically described; it does not claim to exercise reader threads, approval handlers or a native provider.
- Python out-of-order tests compare actual waiter values, not just queue occupancy. CR out-of-order assertions now compare complete response ID, method, success and result. Duplicate/unknown reply, request cap and terminal disconnect checks match the actual CR class. These are synthetic module-level comparisons, not wire-level or process-transport acceptance.
- Router turn-only routing and CR observer thread-plus-turn validation are not conflated. The table explicitly labels CR scope as source-inspected and not exercised by these six checks. Actual CR `observeStarted`, `observeUsage` and `observeCompleted` validate the bound identifiers; usage monotonicity and settlement handling are separate policy responsibilities.
- The CR server-request check establishes classification as `server_request_forbidden`, without handler execution. It does not establish a rejection reply on the wire or prove that a native peer cannot execute tools independently. The report's wording is appropriately limited.
- Default SDK approval behavior is presented as **source inspection, not execution**, with pinned client location. Since `client.py` is cleaned, I cannot independently confirm the exact line-level `accept` claim in this review. Its hash is retained; this must remain an attributed source observation until the full-client refusal test. It is not a demonstrated upstream vulnerability, and the report correctly requires an explicit handler for CR policy.
- Receipt counts agree with the harness: 13 Python checks plus 6 CR checks = 19. The JSON contains reported assertion results, not captured full child stdout/status. No independent execution is implied by this review.

## Fairness to reuse and strongest next alternative

The conclusion fairly rejects replacing a small TypeScript Map with a standalone Python router while retaining the stronger alternative: **full official SDK worker transport plus a narrow CR policy adapter**. It does not use the router's lack of caps/thread binding as evidence that the entire SDK lacks caller/client safeguards. A synthetic-peer full-client experiment with explicit approval refusal, bounded deadlines/frames/queues, exact thread/turn observation and shutdown remains the next useful comparison against the official TypeScript transport. No custom infrastructure or deletion is justified solely by this router-only result.

Disposition: useful module-level comparison with one pre-import reproduction guard to close. No reason to discard the SDK alternative; no full transport/native/production acceptance.

## Focused correction recheck

Source/receipt review only, 2026-09-08; no independent execution or download. **The P2 finding is closed for this bounded reproduction harness.**

- Pre-import checks now require exactly seven expected receipt entries, exactly those source files and the generated directory; reject root/tree/source symlinks, extra initializers, changed hashes and preloaded candidate modules; and use explicit exceptions rather than assertions for identity enforcement.
- The harness creates two explicit namespace modules with pinned `__path__` values instead of allowing an installed regular package to supersede a namespace search. It then checks all six imported module origins and their exact expected closure. `client.py` remains inspected/hash-verified but not imported. These controls establish the intended candidate import boundary; they do not claim isolation of Python/Pydantic or arbitrary interpreter hooks.
- The retained guard harness exercises optimized-Python valid/restored controls plus extra initializer, changed hash, missing file and symlink rejection before candidate imports. The receipt records six guard cases, thirteen actual router checks and six actual CR checks with exit0 for their commands. The router run records the six expected module origins. Behavioral assertions ran without `-O`; only the preflight negative controls used optimization.
- Fetch now requires an empty owned root. Runtime import guards, not fetch's recorded hash alone, enforce the committed source identity.

No remaining blocking finding within this module-level comparison. Full-client server-request refusal, native transport, bounded process lifecycle and policy-wrapper integration remain explicitly unqualified. Reported tool wall-time metadata is not a benchmark of end-to-end runtime. Earlier client default-approval claim remains source-observed rather than independently re-executed here. The strongest full SDK plus narrow CR wrapper alternative is still retained fairly.
