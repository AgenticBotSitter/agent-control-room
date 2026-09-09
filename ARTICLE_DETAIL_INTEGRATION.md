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
existing strict full native schema fingerprint/restore acceptance remains a
separate known gate; these tests do not override it.

## Remaining integration

Connect the existing authorized collection action to bounded extraction and save
after a fresh authority check. Do not make GET trigger fetching. The current
storage/reader checkpoint can display retained extractions, but production
collection does not yet populate them automatically.

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
