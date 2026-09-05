# CR14B B-WIRE — independent correction re-review

Date: 2026-09-04. Reviewer: `remaining_gate_audit`, independent of the producing agent.
The producing agent retained this report from the returned review.

Exact product: `d0858a5eea7f04e600e8d80d429696c87bae394e`.
Tree: `90be4edf28d12be0df8c2a81651b5d4250b9c9f6`.
Correction baseline: `579647788023091bb939d6c5b7b91ae3ae02ea21`.
Cumulative base: `962b7cb7078e120ca2070c7aea5c4d71aac70bdc`.

**Disposition: accepted for the mounted ordinary-project code path. 0 High / 0 Medium / 0 Low.**
All three original findings are closed with no residual issue in this bounded review.

## Findings closed

- **CR14B-WIRE-REV-001:** Every private browser API call now includes
  `X-Requested-With: XMLHttpRequest`. The regression covers list, detail, create, lifecycle and logout,
  and confirms that all 401 responses reach `authentication_required`.
- **CR14B-WIRE-REV-002:** The five-second backoff starts at observable failure time. Failure of that clock
  closes refresh rather than admitting an immediate retry. Tests cover delayed rejection, timeout after
  consuming the loading window, the full post-failure interval and an unmeasurable failure clock.
- **CR14B-WIRE-REV-003:** The session page and recovery links disclose that Access logout ends sessions
  for other protected applications. Ordinary sign-out is reached through the disclosure page; expired-session
  recovery discloses the scope directly. Local exact-session revocation remains a separate operation.

`CR14B_WIRE_INITIAL_REVIEW.md` accurately retains the original negative findings. The wiring contract
describes the corrections without broadening its readiness claim.

## Verification independently observed

- macOS stage zero: `ready_for_runtime_check`.
- Focused CR14B tests: 41/41 passed.
- Existing rebuilt VPS/Sites artifact checks: 7/7 passed.
- TypeScript, focused source lint and whitespace checks passed; checkout remained clean.

The reviewer made no edits, builds, Git mutations, browser, network, credential, provider, native listener,
service, production database or deployment operations. The producer's full-main-suite result is recorded
separately in the acceptance document, not presented as independently rerun here.

Idea integration, pagination, production bootstrap, IdP/MFA, real PostgreSQL, listener/static/browser
rehearsal, deployment and the complete private-pilot exit remain unaccepted. This is not browser-click or
live deployment evidence, and it does not accept unrelated historical components again.
