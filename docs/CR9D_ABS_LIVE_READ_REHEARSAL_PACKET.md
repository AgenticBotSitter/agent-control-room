# CR9D-ABS-060 owner live-read rehearsal packet

**Status:** Prepared, not authorized, and not runnable
**Date:** 2026-08-29
**Contract:** `control-room-abs-news-live-read/v1`
**Controlling decision:** ADR-060

## What this packet permits now

Nothing external. The repository contains the exact request, approval-binding, protected-ledger, cleanup, and outcome contracts plus an injected fake rehearsal. The simulation coordinator has no network client and rejects an `owner_live` authorization. No source was contacted while this packet was prepared.

## Frozen live-read ceiling

A later owner-authorized rehearsal may perform one single-use read of one frozen source set only when every item below is supplied and accepted together:

- one to five exact public HTTPS RSS or sitemap URLs, in canonical source-ID order;
- exact origin, host, and path for each source, with no query, fragment, embedded user information, explicit port, IP literal, localhost, or private host;
- public-address DNS resolution revalidated for every connection and system TLS validation for the exact host;
- redirects denied, including same-host redirects;
- no cookies, authorization header, account, login, credential lookup, newsletter mailbox, Gmail access, search account, proxy credential, or provider credential;
- maximum 100 items per source, 2,000,000 bytes per response, 5,000,000 bytes total, and 60 seconds total runtime;
- zero provider/model budget and zero publication authority;
- a request lifetime no longer than 15 minutes;
- an exact medium-risk Completion Gate request and an owner strong-factor approval resolved from the authoritative approval store; and
- a separately reviewed native transport implementation. The repository does not contain this transport yet.

For the first real rehearsal, the recommended packet is smaller: one or two exact public feeds, at most 50 items per source, 1 MB per response, 2 MB total, and a 30-second runtime ceiling.

## Records that must exist before a read

1. A digest-bound request freezes project, job, attempt, effect intent, sources, content types, time window, ceilings, and idempotency key. The request itself says `liveReadAuthorized: false`.
2. The Completion Gate creates a separate exact strong-factor approval request and authoritative decision.
3. A single-use authorization binds the request and both approval records. It grants only the bounded network read; it grants no command, lease, agent execution, or publication authority.
4. A scope-bound protected ledger records the request, approval records, and authorization before a claim can be made.
5. The ledger claims the request before transport preparation and writes a pre-read marker immediately before the first possible source call.

## Outcome and retry rules

- Exact replay returns the recorded terminal outcome and makes no source call.
- A definite allowlisted failure before any response is terminal. Later sources are not attempted.
- After the pre-read marker, a redirect, malformed result, exceeded ceiling, timeout, crash, restart, missing response, or uncertain transport state becomes terminal ambiguity.
- Ambiguous work is never automatically retried and cannot be given a new idempotency identity to bypass the recorded result.
- Success records only sanitized batch digests, bounded counts, response-body digests, and source-result digests. It never stores or returns the raw response body.

## Cleanup evidence

Every terminal outcome must have an authenticated cleanup receipt proving that transport handles are closed and that no temporary file, cookie, credential, or raw body remains. The current fake rehearsal creates none of those resources. A future native transport must supply independent operational evidence for its own cleanup path before it is eligible for a live packet.

## Owner authorization needed later

The owner must review the completed native transport and a fully populated request containing the exact source URLs and ceilings, then explicitly authorize that one packet. General permission to build Control Room, approval of this contract, an enabled schedule, an accepted news proposal, or approval of a publication package does not authorize the read.

## Explicitly outside this packet

Newsletter login, Gmail, paid search, authenticated feeds, browser sessions, credentials, model/provider calls, persistent schedules, background monitoring, agent dispatch, public ABS website changes, publication, deployment, and every write to an external system remain separate future gates.
