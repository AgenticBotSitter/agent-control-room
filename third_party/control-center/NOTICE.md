# Control Center attribution and adaptation

Source: https://github.com/mreflow/control-center
Revision: `d13e79e866cc33a1fddfe84f563ce2fb9a2113e0`
Original file: `lib/industry-curation.ts`
Copyright (c) 2026 Matt Wolfe. MIT; full notice in `LICENSE` alongside this file.

Original source SHA256 (LF text retained in E03):
`ad668fe4bf08e7b48913b43ef7edb05edbe4d874db1a16c451ff006e0b70d962`.
Original LICENSE SHA256:
`a149b592d1e38b71a4ff4987ee9020b5f35a5fe7c2f09ebdc78ae9ec7a87349b`.

Adapted path: `src/vendor/control-center/industry-events.ts`.
Adopted text cleaning, Unicode title normalization, title stop words, token overlap,
provider-wrapper recognition and sparse generic-title exception. These are pure
helpers; no upstream database, process, dependencies or network defaults were imported.

Control Room changes: event-only data type and precomputed tokens; omit hash-based
identity/shortcut, ranking and URL normalization; preserve distinct numeric model/
version/date tokens rather than treating them as the same event. All eligible news
stories have already passed verification. The sparse-title exception is broadened to
all short token sets on different/unknown direct URLs, not just identical normalized
titles: the first integration run exposed four regressions where distinct short
headlines lost their single-letter distinctions. A comparator has no authority to
verify a story or approve a fetch.

Integration: the news digest selector uses this helper to defer likely duplicate events
across different existing cluster IDs. Existing canonical IDs, story/evidence digests,
strict source cap, score order and verified/freshness filters remain intact. This does
not overwrite or merge source records. Retain this notice and LICENSE when distributing
the adapted helper.
