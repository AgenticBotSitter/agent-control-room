# Public website and single private application delivery

2026-09-07. Owner superseded dual-private-address delivery with one private address
on a separate existing domain. The exact chosen hostname remains in private operator
configuration/conversation, not public source. Finish that login/application and the
separate public informational website. This is not a claim of deployment.
Existing application and PostgreSQL architecture are retained. No new password store,
identity provider, queue or news engine is proposed.

## Surfaces and choices

| Surface | Required behavior | Current position |
| --- | --- | --- |
| Public agentcontrolroom.xyz | Informational page, project/contribution links, no private login link or app data | Static source and website repository handoff exist; current hosted content not verified in this lane |
| Single private address | Full authenticated Control Room, projects/tasks/results | Owner selected a hostname on the separate existing domain and approved the Cloudflare approach; live setup unverified |
| Second private address | Not requested for this deployment | Do not configure; retain optional code unused |

No private address is to be deployed under the public project domain. Do not put actual private infrastructure configuration
into public website content, repository exports or screenshots.

## Login approach

Retain Cloudflare Access and use Cloudflare itself as the login identity provider,
subject to inspection and configuration of the owner's actual account. Restrict to
the approved owner identity and enforce MFA; account membership alone is not a grant
of Control Room ownership. Let the provider manage credentials; Proton Pass may store the chosen account's
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
- https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/cloudflare/

## Retained optional dual-address integration (not deployment scope)

The current deployment omits `secondaryAccess` and uses the existing single-origin
path. The following describes already-built optional behavior, not work still
required to finish this website. Do not create an alias, extra Access application or
cross-domain login session for it.

Use separately configured Access applications/audiences for independent private
addresses, exact origin routing and independent host-only sessions. Both map an
authenticated owner to the same canonical workspace. No cross-domain cookie sharing,
wildcard CORS, trust of arbitrary forwarded identity/host headers, or duplicate database.
The current single-origin private process must not simply accept all origins.

The private process now implements optional `secondaryAccess` origin/audience dispatch
while sharing existing application services and lifecycle ownership. Startup captures
that configuration; omission retains single-origin behavior. The existing Node bridge
now selects a configured HTTPS origin from the exact Host allowlist, never forwarded
aliases. The task host supplies its optional secondary origin. Loopback-only peer
checks, request limits and one resource lifecycle are preserved. These are injected
stream/application checks; actual ingress and cookie behavior remain unverified.
Do not start duplicate queue workers/schedulers just to obtain a
second website. Unknown origins must be rejected. Machine endpoints remain separate
private surfaces, not exposed through either human website. Cloudflare ingress must
not be bypassable by direct public access to the origin.

Current tests cover two correctly signed audience-specific credentials, rejection
under the other site's verifier, same owner/different token identities, cross-origin
write rejection and refusal of a spoofed forwarded hostname. These are isolated
verifier tests. Additional mounted disposable application tests share projects/tasks
across both addresses, while injected Node streams verify host reconstruction. All
31 targeted tests, TypeScript, focused lint and VPS compilation pass. None constitutes
live cookie, IdP, TLS, physical listener or deployment acceptance.

Independent review found that the task host read the secondary address again after
asynchronous startup, allowing caller mutation to disagree with the application's
captured configuration. The host now captures it before awaiting startup. The compiled
regression mutates the original input during installation and confirms the original
address still reaches authentication while the changed address is rejected. Ten compiled
startup checks and five mounted process checks pass, along with TypeScript, focused
lint and VPS compilation. The first regression version occupied the process's single-use
global installation slot and made an existing test fail; it now uses the existing
injected installation/handler seam, preserving the production safeguard.
Mounted checks also show that revoking the secondary token leaves the primary token
usable, while revoking the shared owner grant denies the primary token. This is
application-level behavior, not proof of Cloudflare-wide logout or browser cookies.
Independent source-only re-review confirms the capture finding is resolved and
reports no new concrete defect; the reviewer performed no live operations.

### Reuse decision

Use Cloudflare Access for authentication/MFA and existing `cloudflared` hostname
ingress for routing. The official origin parameters include `httpHostHeader` and
Access assertion validation; no custom proxy or password/MFA service is justified.
See https://developers.cloudflare.com/tunnel/advanced/origin-parameters/ and
https://developers.cloudflare.com/tunnel/advanced/local-management/configuration-file/.
Each approved ingress route must preserve or explicitly set its matching Host and
enforce its Access application; unknown routes terminate in the ingress catch-all.
Inspect the existing tunnel before making changes. Application-side adaptation remains
necessary because the previous request bridge reconstructed every URL as the primary
origin, which would reject legitimate secondary-origin writes and select the wrong
audience. This change extends that bridge; it does not duplicate Cloudflare routing.

## Delivery order and acceptance

1. Inspect existing public deployment read-only and compare it with approved static
   source. Preserve other hosted sites. Verify HTTPS, public links and absence of
   private data; no replacement until the actual target and approval are confirmed.
2. Inspect the selected private hostname's existing DNS/tunnel and Cloudflare login
   configuration, exact owner identity and supported MFA methods. Preserve the parent
   website. Do not solicit secrets in conversation.
3. Complete private origin/Access/identity configuration and application startup,
   reusing VPS_COMPILED_HANDOFF.md. Actual DNS, services, certificates, database and
   account writes require one explicit scoped setup authorization, not guessed values.
4. Test login, deep links, expiration, logout/revocation, MFA, ordinary remembered
   sessions and refusal of anonymous APIs. Test desktop and phone at the real address.
5. Verify only the selected private address reaches the application. No project-domain
   private alias, wildcard host acceptance or public login link may be introduced.
   Keep public static content and private sessions separate. Workplace use requires
   compliance with employer policy; reachability alone does not establish permission.
6. Deliver a batched deployment/rollback handoff with exact releases, configuration
   inventory (no secrets), service ownership and acceptance receipts. Keep Actions off.

Original packet preparation involved no browser/native integration, DNS/account write,
deployment, new download or GitHub activity. Subsequent approved account changes are
recorded below. Website-only readiness must remain
distinct from agent execution readiness. Closing a browser tab never cancels work.

### Read-only account inspection after the single-address decision

The authenticated Cloudflare dashboard is available. Its Access inventory showed
three pre-existing applications, none identified as Control Room, and the overview
reported one active tunnel. Neither observation proves a suitable Control Room
origin service exists. The identity-provider inventory contained only One-time PIN.
The Add Cloudflare screen is available; its account-member restriction defaults off.
No login method, Access policy, DNS record, tunnel or service was changed.
Before saving an account-wide login method, inspect existing applications' accepted
login methods and obtain confirmation of the security-sensitive change. Restrict
the new method to account members and retain explicit owner-only application policy;
do not authorize all account members as Control Room owners. MFA and live acceptance
remain unfinished. Do not copy account identifiers or unrelated application details
into this handoff.

### Approved login-provider setup

After the owner authorized preserving existing login behavior and adding restricted
Cloudflare login, both pre-existing applications with "Accept all available identity
providers" enabled were changed to explicitly select their sole existing One-time
PIN provider. Both saves displayed "Application successfully configured". Their
access policies, destinations, durations and service-token rule were not edited.
The remaining existing application already selected providers explicitly and was
left unchanged. These are configuration observations, not live login/agent tests.

The Cloudflare login method was then saved with "Restrict to account members" On.
The provider inventory displayed the new Cloudflare entry alongside One-time PIN;
reopening its stored settings confirmed the restriction remained On. Intermittent
browser action detachments were resolved through observed state and supported
keyboard controls; no uncertain save was repeated. This does not establish MFA,
owner-only Control Room membership, application policy, DNS/tunnel configuration,
origin availability or successful real login. No website deployment or GitHub write
was performed. No account identifiers or private hostname values are retained here.

### Domain, tunnel and application preparation

The selected existing domain is Active in the authenticated Cloudflare dashboard.
Its DNS inventory has no record for the chosen private label; existing store and
email records were not modified. The existing tunnel reports Healthy and has
published routes for other applications and the public project website, but no
selected private Control Room route. That is not evidence of a running Control Room
origin or a suitable unused service port. Reuse the tunnel only after actual origin
readiness is established; do not copy another application's port.

An unsaved Control Room Access application draft now contains the selected private
hostname and Cloudflare-only identity selection, without One-time PIN fallback.
No policy is attached and Create was not submitted. The MFA tab reports that
independent MFA is not enabled for the account. Read-only inspection confirms all
five independent MFA method toggles are Off. Account session duration is shown as
Same as application session timeout. Enabling approved MFA methods, attaching an
owner-only policy and saving the Access application remain required; account-wide
domain blocking, unrelated apps, DNS and tunnel routes must remain unchanged.
Actual authenticator enrollment is an owner action. A browser draft is not a durable
configuration or proof of protection and must be revalidated before submission.

### Explicitly approved authenticator-method enablement

The first attempt under a general continuation was rejected by the action reviewer;
readback confirmed the setting remained Off and no workaround was attempted. The
owner subsequently explicitly approved enabling authenticator-app MFA. The
Authenticator application method was then enabled in Access settings. Readback,
including after a full reload, confirmed On. Other MFA methods and account-wide
domain blocking remain Off. No credential was enrolled, no application policy was
created, and no DNS or tunnel route was changed. This enables the method, not MFA
enforcement on Control Room. The dashboard directs the owner to the Account page of
the App Launcher for enrollment; the owner must handle the authenticator secret,
confirmation and recovery material themselves.

### Owner-approved App Launcher enrollment access

The owner reported that the direct enrollment link reached NoAuth. Read-only
inspection found no App Launcher policy, and the dashboard explicitly requires one.
After approval, the existing exact-owner-email Allow policy was attached unchanged,
Cloudflare selected as the only login provider, and a six-hour launcher session saved.
Reload confirmed the exact policy identity, Cloudflare-only selection and duration.
Launcher MFA was left respecting the existing non-enforcing global setting so first
enrollment remains reachable; Control Room requires a separate enforced MFA policy.

A proposed duplicate policy form did not yield save confirmation; the persisted
policy inventory showed no new policy, and that draft was discarded in favor of
the verified existing owner rule. No broad email-domain or account-member Allow rule
was used. The entry point and routine sign-in were then tested in Chrome, reaching
"Secure your account with MFA" and "Set up authenticator application MFA". Execution
stopped before that setup button: no QR code, TOTP secret, verification code or
recovery material was accessed, and owner enrollment remains pending. This verifies
the enrollment entry flow in Chrome, not another browser session or Control Room
deployment. No DNS, tunnel route or Control Room application was saved.

## Public copy checkpoint

The retained public release receipt confirms source publication, but the static page
still said no public download existed. The local page/README now describe the published
pre-alpha, keep production-readiness caveats and direct contributors to agree on work
before starting. All four source checks pass. Styling, assets and private-link exclusions
are preserved under existing-site guidance. The web reader refused opening the live
domain; this is not evidence that the site is down. Deployment comparison remains open.
