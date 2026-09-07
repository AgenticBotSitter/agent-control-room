# Website, login and dual-address delivery

2026-09-07. Current owner goal: finish the website, login, dual website interface
and supporting items. This is the active website lane, not a claim of deployment.
Existing application and PostgreSQL architecture are retained. No new password store,
identity provider, queue or news engine is proposed.

## Surfaces and choices

| Surface | Required behavior | Current position |
| --- | --- | --- |
| Public agentcontrolroom.xyz | Informational page, project/contribution links, no private login link or app data | Static source and website repository handoff exist; current hosted content not verified in this lane |
| Primary private address | Full authenticated Control Room, same projects/tasks/results | Private hostname and actual identity provider requested from owner; current app accepts one configured origin |
| Optional second private address | Same application data and permissions, independent site login | Exact hostname and employer-approved use remain unconfirmed; deployment disabled |

Candidate primary labels offered to owner: room, app or cr. None is selected or
published by this document. Do not put actual private infrastructure configuration
into public website content, repository exports or screenshots.

## Login approach

Retain Cloudflare Access and an existing configured identity provider. Let that
provider manage password/passkey and MFA; Proton Pass may store the chosen account's
credentials where supported, but is not presumed to be an identity provider.
Owner membership remains explicitly checked by Control Room after signature,
issuer, audience and time validation. Do not infer membership from an email header.

Target an ordinary remembered session of at most seven days on a trusted personal
device, capped by upstream expiration and shorter policy. Use a shorter policy on
shared devices. This is a desired configuration, not a guaranteed uninterrupted
seven-day login: Access application, policy, global and MFA sessions all matter.
Keep consequential-action approval separate from login; no repeated development
one-time code should be required for ordinary deployed browsing.

Official references checked 2026-09-07:
- https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/session-management/
- https://developers.cloudflare.com/cloudflare-one/access-controls/policies/mfa-requirements/
- https://developers.cloudflare.com/cloudflare-one/access-controls/access-settings/independent-mfa/
- https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/

## Dual-address integration boundary

Use separately configured Access applications/audiences for independent private
addresses, exact origin routing and independent host-only sessions. Both map an
authenticated owner to the same canonical workspace. No cross-domain cookie sharing,
wildcard CORS, trust of arbitrary forwarded identity/host headers, or duplicate database.
The current single-origin private process must not simply accept all origins.

Before mounting a second address, implement and test explicit trusted-origin dispatch
to the correct audience verifier while sharing existing application services and
lifecycle ownership. Do not start duplicate queue workers/schedulers just to obtain a
second website. Unknown origins must be rejected. Machine endpoints remain separate
private surfaces, not exposed through either human website. Cloudflare ingress must
not be bypassable by direct public access to the origin.

Current tests cover two correctly signed audience-specific credentials, rejection
under the other site's verifier, same owner/different token identities, cross-origin
write rejection and refusal of a spoofed forwarded hostname. These are isolated
verifier tests, NOT mounted dual-address, cookie, IdP or deployment acceptance.

## Delivery order and acceptance

1. Inspect existing public deployment read-only and compare it with approved static
   source. Preserve other hosted sites. Verify HTTPS, public links and absence of
   private data; no replacement until the actual target and approval are confirmed.
2. Resolve primary private hostname and provider; inspect existing Access configuration
   and supported MFA methods. Do not solicit secrets in conversation.
3. Complete private origin/Access/identity configuration and application startup,
   reusing VPS_COMPILED_HANDOFF.md. Actual DNS, services, certificates, database and
   account writes require one explicit scoped setup authorization, not guessed values.
4. Test login, deep links, expiration, logout/revocation, MFA, ordinary remembered
   sessions and refusal of anonymous APIs. Test desktop and phone at the real address.
5. Add the separately approved second address through exact-origin composition.
   Verify both see identical project/task state, cannot exchange credentials/CSRF
   requests, and cannot duplicate task execution. Test independent session behavior
   and explain the existing Access-wide logout effects.
6. Deliver a batched deployment/rollback handoff with exact releases, configuration
   inventory (no secrets), service ownership and acceptance receipts. Keep Actions off.

No browser/native integration, DNS/account write, deployment, new download or GitHub
activity occurred in preparing this packet. Website-only readiness must remain
distinct from agent execution readiness. Closing a browser tab never cancels work.

## Public copy checkpoint

The retained public release receipt confirms source publication, but the static page
still said no public download existed. The local page/README now describe the published
pre-alpha, keep production-readiness caveats and direct contributors to agree on work
before starting. All four source checks pass. Styling, assets and private-link exclusions
are preserved under existing-site guidance. The web reader refused opening the live
domain; this is not evidence that the site is down. Deployment comparison remains open.
