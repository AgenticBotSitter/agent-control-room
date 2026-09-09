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

## Remaining integration

Add a separate immutable article-detail table keyed by scoped story version and
detail digest, with a foreign key to the retained story version. Store an integrity
tag using the existing news key. Exact replays must verify saved bytes/tags; writes
must not overwrite previous detail versions. A protected GET may read retained
detail but must never trigger a fetch. An explicitly authorized collection action
may perform bounded extraction and save after a fresh authority check.

Schema migration and least-privilege grants require real disposable PG17 tests.
Do not reuse native-result storage or raise its shared size limit. Article text
has a separate 128 KiB ceiling; input is 512 KiB, with two workers and a three-second
deadline. Overflow is a failure, never silent truncation. The 64 MiB V8 old-heap
limit is not a total-process memory sandbox; hostile resource testing and deployment
memory policy remain acceptance work.

The protected page must show complete saved extraction or an explicit unavailable
state with source link and summary fallback. It must label source content untrusted,
use the existing inert text renderer, and refuse stale project/session responses.
Full reading acceptance requires actual storage/route/browser tests, including two
projects, expired access, stale story, replay, changed bytes and parser failure.

No automatic publication of copyrighted article text is introduced. No provider
call, live fetch, database migration or runtime service has been started by this
checkpoint.
