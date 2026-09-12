# RC3 actual transcript renderer: source closure and bounded preparation

2026-09-08. **Twenty actual mounted renderer checks passed after an explicitly
approved resource-limit adjustment.** This resolves the renderer span substituted
in the earlier MessageRow experiment, but is not whole RC3 acceptance.
No application code, package manifest or dependency tree was changed.

## Actual selected source

Hermes Desktop pin `3f744975f818bbb40ed029e6b3022cd0c5ad7a24`:
`src/renderer/src/components/AgentMarkdown.tsx`, `MediaImage.tsx`,
`useI18n.ts`, `src/renderer/src/hooks/useLightboxClose.ts`, and
`src/renderer/src/screens/Chat/mediaUtils.ts`. Exact byte hashes, paths and public
URLs are in `f3-renderer-acquisitions.json`. The Markdown test, root MIT license,
manifest and lockfile were also read. Exploratory tree/package metadata was read
in memory before the retained acquisitions; those exploratory reads do not have
saved hashes. No claim of a complete network-request audit is made.

The actual upstream Markdown test checks syntax highlighting, box-drawing fallback
and diff rendering, while mocking media and translation. It was read, not run.
This packet has not yet inspected or run WebUI's full renderer closure; earlier
WebUI session/status-function evidence must not be presented as renderer evidence.

## Concrete adaptation costs discovered in code

| Existing behavior | Integration implication |
| --- | --- |
| React Markdown with GFM, custom code/diff/box rendering and lazy Prism highlighting | Useful presentation without rebuilding Markdown parsing. The mounted checks below cover one unsafe link and one raw-script sample; this is not a sanitization certification. |
| HTTP(S) link clicks prevent default and dispatch `web-preview:navigate`; mailto calls `window.hermesAPI.openExternal` | A browser host needs a reviewed navigation port. Relative URLs are resolved against a placeholder solely for protocol checking, then the original string is dispatched. Native browser navigation is not supplied by this component. |
| Code-copy calls `window.hermesAPI.copyToClipboard` | Requires browser clipboard adaptation, with actual permission/error handling not qualified by a synthetic callback. |
| Local images call `readMediaFile`; save and context menus call native IPC; HTTP(S)/data images render directly | Reuse display logic only after routing retained artifact identity through Control Room's access boundary. The renderer cannot authorize a filesystem path. A synthetic data-URL resolver is a test port, not an implementation. |
| Lightbox portals to document body; Escape is capture-phase and stops propagation | Can be mounted with the actual hook in a DOM fixture. Layout, focus containment and native browser keyboard behavior remain a separate check. |
| Module-level expanded-code set is keyed by AST offset/line plus language | Reproduced: expanding message A also makes a newly mounted message B's same-offset/same-language block expanded. Same-message streaming preservation works. The global key is not project/message isolation. |
| `describeImageSrc` tests extension on the entire string | Reproduced: `.png?v=1` renders a download chip rather than an image. Plain HTTPS `.png` renders as an image. |

AgentMarkdown contains no Approve/Deny controls. Do not reintroduce MessageRow's
prose-matched controls just to test this renderer. Current Control Room result
presentation and fingerprint/review binding remain intact; rendering richer text
does not replace its protected content read or grant execution authority.

The strongest smaller alternative is using the actual react-markdown/GFM libraries
directly inside the existing verified-result presentation, borrowing only selected
Desktop code/diff presentation. It avoids importing native media/navigation state.
Those real libraries ran within the candidate; a separate current-CR composition
is not yet mounted or selected. No custom Markdown parser is
justified by the identified gaps. No production deletion estimate is warranted:
the existing result identity/read/review machinery is not renderer duplication.

## Dependency preparation and bounded failure

An isolated selected lock closure was derived from the actual upstream lockfile:
React/ReactDOM 19.2.4, react-markdown 10.1.0, remark-gfm 4.0.1,
react-syntax-highlighter 16.1.1 and jsdom 26.1.0, with 153 package records.
This uses the candidate React version, not proof of current Control Room's React
19.2.6 compatibility. No Electron, SQLite/native installer or full app installation
was requested. Npm used `ci`, scripts disabled, optional dependencies omitted,
legacy peer handling, dedicated cache/home and distinct empty config files.
The exact package versions, tarball URLs/integrities and selected lock hash are
retained. The 50 MiB root-allocation monitor sent SIGTERM during installation;
npm exited 1 and rolled back, leaving 10,440 KiB. The precise crossing/peak sample
was not retained, so 50 MiB is the threshold, not a measured peak. Failure output
is preserved in the receipt. No alternate installer, cleanup-around-limit or
unauthorized retry was attempted. Root then explicitly increased this exact cohort
to 200 MiB (unchanged global 4 GiB/free 20 GiB), preserving the failed attempt.
The unchanged frozen closure installed successfully: exit 0, 153 packages,
63,696 KiB final/sampled maximum allocation. Sampling is not a precise peak RSS
or a guarantee no between-sample disk spike occurred. Available disk before the
resumed preparation was 145,415,340 KiB. No candidate source changed for preparation.

The lockfile declares MIT, ISC, BSD-2/3-Clause, CC0-1.0, MIT-0 and Apache-2.0;
`format@0.2.2` lacks a lock license field, but its installed Readme License section
and source header identify MIT/Sami Samhuri and link externally to the license.
That is not a bundled full MIT text. These are metadata/source notices, not
full-text clearance.
Desktop's own MIT notice was read. Exact transitive notice inspection remains
required before adoption/distribution; personal use is not a waiver.

## Actual execution and limitations

Stage zero returned `ready_for_runtime_check`. Command:
`node research/reuse-comparisons/f3-renderer-fit.mjs` exited 0 on its first run,
with 20 checks and 271.757125 ms measured inside the harness. The receipt is
`f3-renderer-evidence.json`. Source hashes and selected dependency lock hash are
asserted before candidate evaluation. The entire actual AgentMarkdown, MediaImage,
mediaUtils and lightbox-hook bodies are transpiled unchanged into CommonJS. Lazy
imports become require calls through TypeScript; the actual installed highlighter
and actual one-dark theme execute. There is a positive `.token` acknowledgment,
not an assumed async sleep success. The test waits at most 2.5 seconds for it.

Only translation (keys) and three decorative icons (null) are substituted in UI
imports. Runtime ports are authored in-memory callbacks: clipboard/open/save/menu/
read/existence; only clipboard/open/save/read were invoked. They do not implement
OS permissions, native media resolution or an actual browser navigation host.
JSDOM uses no resource loader or script execution, and no listener/server starts.
The actual lightbox hook receives synthetic Escape, not a physical keyboard.
No root permission/approval controls are copied. The VM is not a security sandbox.

The run positively establishes actual GFM table/strike/inline rendering, absence
of an executable script node for one raw-script sample, no runtime dispatch for
one javascript link, HTTPS/relative preview events, mailto port delivery, actual
code copying, diff/box presentation and streaming expansion retention. This is
not an exhaustive sanitizer, CSP or URL-obfuscation test.

Actual media code renders a direct image, creates/removes a lightbox portal,
routes a PDF to the save port, ignores an acknowledged old pending media reply
after Markdown changes, and displays the current resolved reply. Both old/new
requests are positively acknowledged before releasing them. A separate standalone
MediaImage reused without a key across direct URL changes retains the first
resolved source; this is an integration-key/state-reset requirement, not evidence
that the tested Markdown-remount path displays stale media. Three checks deliberately
preserve these negative adaptation observations rather than hide them in a pass count.

React roots are unmounted, copy-feedback timers cleared and JSDOM closed in finally.
No failure/repair was needed for the actual renderer run. Styles, browser focus,
network-image policy, real clipboard, artifact authorization, actual protected
HTTP composition, current CR React 19.2.6 and bundler integration are not qualified.
No candidate-specific production RAM/size/latency comparison has been measured.

## Next integration decision

Prefer comparing a narrow react-markdown/GFM composition inside current verified
result presentation against adapting this native-oriented renderer. The latter
requires navigation/clipboard/media ports, stable message scoping and query URL
handling; reuse its code/diff/box presentation where that saves work. Keep result
identity/review checks outside untrusted prose. A VM import boundary is not a
sandbox. JSDOM is not browser/mobile/layout qualification. Report every substitution,
positive acknowledgment, negative observation and failure independently.

Independent source/receipt review (`f3-renderer-review.md`) found no material
blocker to these narrow observations and independently matched all nine source
hashes plus the selected lock. It is not final product/adoption acceptance.

Cleanup completed after that review: `lsof +D` for exact owned root returned no
handles; the renderer process was terminal. Removed only
`/private/tmp/cr-f3-renderer.XRtXHb` (63,696 KiB source/dependencies/cache) and
observed `ENOENT` afterward. Pinned manifests, acquisition hashes and sanitized
failure/success evidence remain; downloaded contents are reacquirable. No other
cohort, application dependency or user data was removed.
