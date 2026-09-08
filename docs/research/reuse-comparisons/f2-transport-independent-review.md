# Independent F2 transport review

2026-09-08. Source/receipt review only; no independent runtime, download or native/provider attempt. Reviewed `f2-transport-fit.md`, `f2-transport-evidence.json`, both `research/reuse-comparisons/f2-transport-*` scripts and selected actual SDK spawn/exit/finally source at the retained pin.

No blocking defect for the report's narrow conclusion: this is actual public SDK process transport to a synthetic Node executable, not a mocked spawn and not native Codex qualification. Source hash precedes import; public path override avoids discovering installed Codex. Report correctly retains output-allocation/error-redaction gaps, descendant cancellation uncertainty and native authorization gates. No unsound production deletion or whole-family acceptance recommendation found.

Two small strengthening opportunities:

1. **P3 — argument assertions incomplete.** Start asserts exec/CD/approval/network, while sandbox and web-search flags are supplied and visible in retained evidence but not asserted. Add exact value assertions for `--sandbox read-only` and `web_search="disabled"`, and assert `inputBytes === 16`, so the executable check fully matches the report's argument/stdin claim. Current recorded observation is valid; future regressions could slip through its checks.
2. **P3 — cleanup trace coverage.** Start and resume both use `success.json`, so second invocation overwrites first PID receipt. The SDK awaits successful process exit before normal completion, reducing practical risk; nevertheless the final explicit PID check covers retained latest traces, not a complete append-only record of every spawn. Use distinct attempt trace IDs or preserve each receipt immediately before the next invocation to make the all-owned-PIDs assertion exact. This is not evidence a process survived the reported run.

Abort checks an acknowledged cooperative emitter, actual AbortSignal error and absence of its recorded PID. It does not test ignored SIGTERM, descendant tree termination or sessions. The synthetic wait mode's two-second fallback bounds this peer only. Other failure fixtures are short finite emitters, not malicious unbounded writers. SDK source closes readline, removes listeners and sends kill in finally without a demonstrated hard output budget. These limits are correctly disclosed.

Environment proof is confined to keys of one synthetic child on macOS. Extra allowed platform encoding key is not a credential read; report preserves the initial failed exact-key assumption. Parent-only RSS is accurately labeled. App Server remains a distinct viable interactive transport, not disproved by this exec-path result.

## Focused correction disposition

Source/receipt recheck, no independent rerun: both P3 findings addressed. Start now asserts exact sandbox value, disabled web search, prompt byte length and synthetic prompt equality. Each SDK instance receives an incremented numeric fixture ID, validated by the peer and included in its trace filename; start/resume no longer overwrite one PID record. Finally enumerates all generated JSON traces. `f2-transport-recheck-evidence.json` records eight checks, `inputBytes: 16`, `inputMatches: true`, cleanup true and no remaining recorded PIDs. This closes the identified research-harness assertion/receipt gaps only; native enforcement, hostile-child/descendant cleanup and full output bounds remain outside acceptance.
