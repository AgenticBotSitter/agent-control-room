# Article detail integration

This is an implementation boundary for batch 4, not a production-start approval.

## Selected design

Keep the existing news collector, canonical story schema and research draft source
binding. Readability/jsdom supplies article text; the application wrapper supplies
bounded execution and exact story association. No parallel collector is needed.

The trusted `readNewsArticleDetail` composition accepts an authenticated scoped
store and the existing bounded public reader. It verifies the current retained
story before and after asynchronous work. No URL supplied by an article can
replace the canonical story URL. Parsing never grants network or task authority.

Successful output includes tenant/workspace/project, story ID and digest, canonical
URL, fetched UTF-8 text hash, extractor version, plain text and a detail digest.
This hash describes the supplied decoded UTF-8 input, not compressed wire bytes.
Changed input yields a distinct detail; it never rewrites approved task lineage.

## Storage and reading checkpoint

Migration 0065 adds immutable `control_abs_article_details` with exact story-version
foreign key, a 128 KiB text constraint and no automatic grants. The existing web
role gains SELECT only; news ingestion gains SELECT/INSERT. Startup verifies the
updated role contract and schema fingerprint; it does not apply either template.

`PostgresArticleDetails` verifies payload digest, indexed digest, scope and HMAC on
read/replay. Exact-version reads remain available; omitted detail digest selects
the most recently recorded extraction for the exact requested story version.
The record is never treated as a native agent result or used to rewrite a task.

The protected GET `/api/v1/projects/:projectId/news/article` requires storyId and
storyDigest, with optional detailDigest. It reuses the existing session/project
authority, returns no-store responses, and performs no fetching. The news page now
offers a saved-article reader using the existing inert renderer. It discards stale
project responses and clears/revalidates on focus, visibility and a 15-second timer.
This is periodic access revalidation, not instantaneous removal of already-delivered
content or a hard guarantee about background-browser timer scheduling.

Local evidence covers actual extractor to store to authenticated process GET,
expired access, duplicate query parameters, refused POST, immutable rows, HMAC/key
replay refusal and fake-DOM reader interactions. Real disposable PG17 confirms
save/replay/readback and a dedicated SELECT-only login's denied mutations. The
strict native website-profile restore check now passes after additive migration
0066. Two successive logical restores preserve the exact fingerprint, table data,
relation/function ownership and effective ACLs, and restricted project readback.
This is disposable evidence, not production backup or artifact-pairing acceptance.

## Remaining integration

The existing configured discovery collection now supports optional `limits.maxArticles`
(1–10). Omitted means no article reads, preserving old approvals. The field is
included in the configuration/plan digest and shown in the approval description.
An operator must explicitly add it to a newly approved template to enable it;
no existing deployment/template has been changed by this implementation.

Article reads reuse the discovery reader's approved destinations, request count,
reserved-body budget and deadline. Extraction receives the same cancellation
signal. It saves only under the unchanged source revision and exact story binding.
Transport/storage uncertainty propagates to the existing held path; parser refusal
prevents confirmed completion. Metadata may already be retained when an article
fails. A source summary alone is not full-reading success.

The Node build now includes the fixed parser worker and its module beside generated
importers, and exposes a compiled extraction entry for packaging tests. Both source
and compiled cancellation/extraction tests pass. Disposable real PostgreSQL tested
the configured collector through retained article storage with synthetic HTTP
responses. This does not claim a live source read or native agent research result.

Deployment of the migration and role changes requires its operator gate.
Do not reuse native-result storage or raise its shared size limit. Article text
has a separate 128 KiB ceiling; input is 512 KiB, with two workers and a three-second
deadline. Overflow is a failure, never silent truncation. The 64 MiB V8 old-heap
limit is not a total-process memory sandbox; hostile resource testing and deployment
memory policy remain acceptance work.

Real browser visual/accessibility validation and hostile-parser resource testing
remain. Fake-DOM interaction tests and ordinary fixtures cannot substitute for
those checks or live approved-source collection acceptance.

No automatic publication of copyrighted article text is introduced. No provider
call, live fetch, database migration or runtime service has been started by this
checkpoint.
