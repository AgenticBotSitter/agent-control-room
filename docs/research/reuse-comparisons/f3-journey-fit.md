# RC3 transcript prose versus authoritative result actions

2026-09-08; next bounded seam after the earlier17 project-strip checks.
**Eleven new mounted DOM checks passed.** The actual Desktop message row supplies
usable transcript presentation, but automatically adds Approve/Deny controls when
last assistant-message text matches a regex. Control Room must not treat that as
an authoritative result review or native permission. Current protected result
presentation already has stronger source/result meaning and should remain.

## Actual candidate and current components

Hermes Desktop pin3f744975f818bbb40ed029e6b3022cd0c5ad7a24:
`src/renderer/src/screens/Chat/MessageRow.tsx`, its test, and `mediaUtils.ts`.
Exact downloaded byte hashes/URLs in `f3-journey-acquisitions.json`; hashes checked
before candidate evaluation. The full unchanged MessageRow body and full actual
media helper were transpiled using installed TypeScript and mounted with React.
The selected test was read, not run: it tests user Markdown/copy with desktop IPC.
Prior same-pin MIT notice applies; no broader dependency license clearance implied.

Substitutions are explicit: avatar/icons/attachment/media displays inert; translation
returns keys; date formatting synthetic; AgentMarkdown becomes a text span. This
does **not** test upstream Markdown, media access, IPC clipboard, styling or the
entire Desktop transcript. Only the row's actual conditional rendering, callbacks,
React state and media segmentation run. VM import allowlist is not a security sandbox.

Current actual `private-app/app/task-results.tsx::PrivateTaskResults` and
`TaskResultsPanel` are mounted unchanged. Their actual task-browser-client reads
strict result schemas, checks project/job/artifact identity and hashes exact bytes.
Transport is authored synthetic GET Responses (including401), not the actual
Access-authenticated HTTP handler or server/database. Candidate receives the same
result bytes obtained through that actual client. This is E3 narrowly for data/client/
component composition, **not** end-to-end protected server authority qualification.

## What the run establishes

1. A synthetic result containing `Do you want me to execute this?` and script-like
   literal text is verified and rendered as text by actual CR results. No script node
   or candidate-style approval control appears.
2. Actual Desktop row's APPROVAL_RE matches that same prose when role=agent, last,
   not loading and no error. Clicking its real DOM Approve button invokes the supplied
   callback once. This is an integration mismatch, not an upstream vulnerability:
   the callback may be legitimate in Desktop's conversation model, but here the
   row has no CR review target, content fingerprint, permission or approval binding.
3. Loading and nonlast states suppress those controls; ordinary answer text also
   suppresses them. The same native button can be focused programmatically in DOM.
   This does not simulate browser-native keyboard activation or tab order.
4. Actual Close result clears open bytes and causes no write/cancellation. After
   reopening, focus-triggered401 refresh clears private content; remount under401
   does not restore it. These are real component/client behaviors against synthetic
   responses, not account revocation or a full page/browser-storage reload.
5. Unmounting controlled candidate view clears its labels and produces no additional
   approve/deny callbacks. This is not a candidate-owned auth-cache clearing feature.

Nine HTTP calls were GET/no-store/same-origin, zero writes; one deliberately invoked
candidate callback, zero denial callbacks. No broker, provider or execution port was
connected. First run succeeded with no repair. Exact command and condensed terminal
receipt: `f3-journey-evidence.json`; reproduction fixture `f3-journey-fit.mjs`.

## Decision consequence and strongest alternatives

Keep current result identity, byte checks, review matching, revoked-read clearing and
close-view behavior. Current Needs Me (`needs-me/task-attention.tsx`) derives reasons
from saved task/review records and links exact project/job; source inspected here,
not mounted in this packet. Replacing that with assistant-text heuristics would erase
the authority distinction. Needs Me end-to-end navigation remains uncovered here.

For a future transcript, **adapt narrowly** only after root chooses the presentation
contract: remove/replace regex-driven permission controls, route review navigation
through current exact result/task identity, and keep actual review controls outside
untrusted message content. Do not make no-op Approve buttons and claim a safe UX.
An alternative is using current result UI unchanged plus existing transcript-specific
building blocks; that has zero permission-heuristic migration. The full Desktop row
is not automatically cheaper once Markdown/media/IPC dependencies are counted.

WebUI's earlier action/status helpers remain complementary, not a tested result-review
replacement. This packet did not copy or re-run those17 earlier checks and does not
claim whole F3 closure. No production code deletion; row presentation could avoid
writing chat-bubble/copy/avatar arrangement, but downstream rendering is not qualified.

Scoped judgment0–5 (higher better): current result-authority fit5; unchanged candidate
result-action fit1–2; candidate transcript presentation fit3 with rendering dependencies
unqualified; adaptation ease2–3. Resource/maintenance comparison unknown. No weighted
winner, full candidate rejection or permission architecture selected by this report.

## Remaining decisive local work

- Mount a root-approved adapted transcript using the **actual** Markdown/media closure
  or existing reviewed renderer; check untrusted content and file links without native
  file access. Preserve result/digest/review separation.
- Join actual authenticated handler/data with project→Needs Me→task→result navigation;
  distinguish synthetically injected responses from real server eligibility checks.
- Real browser keyboard activation/tab order, CSS/mobile geometry, scaling and true
  page reload/persistence remain untested. JSDOM has no layout engine; screen widths,
  snapshots or source strings would not supply that evidence.

## Resources and cleanup

Stagezero ready before execution.139GiB free before download. Three pinned source/test
files plus isolated jsdom26.1.0 (39 packages, scripts disabled, no audit/fund,15s fetch
timeout/no retries). All package versions/resolved URLs/integrities and lock hash are
in the acquisition receipt. No global/app install or lockfile changes. React roots
unmounted and DOM window closed in finally. Source and dependency root cleanup is
recorded below after receipt preservation; no service/browser/native agent was started.

Final allocation30,816KiB, well below4GiB. Exact owned root
`/private/tmp/cr-f3-journey.6cH9qu` removed; absence check exit0. Downloaded source,
jsdom dependencies and isolated npm cache were removed (recoverable from recorded
pins/URLs); authored fixtures and sanitized receipts remain. No other cohort touched.
