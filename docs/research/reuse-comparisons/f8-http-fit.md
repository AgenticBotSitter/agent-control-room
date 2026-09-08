# F8 actual HTTP transport follow-up

## Reviewer correction and fresh run

The initial harness assumed a non-throwing branch meant success. Independent review correctly required observing actual upstream `bean.status`. The corrected harness begins `unknown` and maps success only when the upstream block sets `bean.status === 1` (UP). Expiry cannot turn an unknown/error into stale success evidence. It now also asserts exact ERR_BAD_RESPONSE, ECONNRESET and ECONNABORTED codes, not merely fail/unknown states. Same-pin sources/dependencies were reacquired under `/private/tmp/cr-f8-http.kfgT1q` with scripts disabled after checking 140 GiB free; root stayed below 25 MiB. The real loopback recheck passed all 11 cases (11 requests), exit 0, 0.576768041 seconds. `f8-http-recheck-evidence.json` is the directly parsed actual tool stdout plus exit/time, not a transcription. Initial evidence remains for audit. Acquisition identities are in `f8-http-recheck-acquisitions.json`. Exact second root removed and absence checked; all owned server handles closed. This fixes a research assertion gap, not an upstream/product defect or broader qualification.

Research only, 2026-09-08. Upstream Uptime Kuma revision `e4821321e559c887b14e37d9979e604b221a8945`. No product changes or production approval.

## Actual experiment

`research/reuse-comparisons/f8-http-live-fit.ts` verifies three complete upstream source SHA256 hashes **before** AST extraction/execution. Executes the entire actual HTTP/keyword/json-query block, actual `makeAxiosRequest`, `checkStatusCode`, `axiosAbortSignal`, and transpiled actual `evaluateJsonQuery`. Real pinned Axios 0.32.0, dayjs 1.11.23, jsonata 2.1.1, tough-cookie 4.1.4 and http-cookie-agent 5.0.4 match the upstream lock's selected versions. The isolated dependency lock/registry integrity and source hashes are recorded in `f8-http-acquisition-receipt.json`. This is not a complete upstream lock installation.

The fixture is a real HTTP server on an ephemeral 127.0.0.1 port. Requests use real Axios with ambient proxy disabled, redirects disabled, no authentication and a 150ms timeout. Exact upstream branch builds request options and performs classification. Monitor configuration methods and log sink are research ports; full surrounding scheduler, ORM, TLS/auth branches and notifications are excluded rather than qualified with stand-ins. The VM is an extraction mechanism, not a security sandbox. Selected source was inspected; only controlled fixture URLs execute.

Results: 11/11 cases, 11 actual HTTP requests, exit 0 in about 0.58 seconds. Initial sandbox invocation failed `listen EPERM` before a request; approved scoped execution then passed. No external service contacted.

| Actual request / mode | Observation | Meaning |
|---|---|---|
| Ready JSON / state query | pass | Actual upstream JSONata/helper integration succeeds |
| Login HTML 200 / plain HTTP | pass | Availability alone is not readiness; configuration limitation, not upstream bug |
| Login HTML 200 / state query | fail | Stronger built-in mode rejects wrong response structure |
| Error HTML containing marker / keyword | pass | Substring marker alone insufficient; not a product-wide rejection |
| Stale JSON state / state query | fail | Explicit stale state rejected |
| Ready state plus expired timestamp | upstream succeeds; adapter stale | Timestamp interpretation is supplied by research adapter, NOT upstream query proof |
| HTTP 503 | fail / ERR_BAD_RESPONSE | Actual status filter/client rejection |
| Server destroys socket | unknown / ECONNRESET | Actual disconnection; safe adapter does not invent success |
| Server never responds | unknown / ECONNABORTED | Actual client timeout |
| Repeat ready request | same CR digest | Deterministic observation only, NOT notification dedup |
| Own server close/reopen then request | pass | Endpoint recovery only, NOT Kuma daemon restart/persistence |

All outcomes flow through the actual `buildOperationsHealthProbeV1`, with assertions that observations grant neither service-control nor deployment authority. Observer and evidence identities are disposable digests. The selected state query is deliberately minimal; a stronger JSONata query could validate freshness as well. This experiment does not reject Kuma for lacking CR-specific authority semantics.

## Decision and exact remaining work

This advances F8 beyond classifier-only E2: bounded real-transport integration evidence exists for the selected HTTP observation seam. It is **not** full Kuma service acceptance. Prefer Kuma's maintained JSON-query/status/timeout machinery as a separate observational component rather than custom HTTP uptime monitoring. Keep CR's health/evidence authority boundary. No production code deletion is justified yet: the current CR health builder is not the equivalent of Kuma's scheduler, persistence or alerting.

Next isolated full-service test must establish restart recovery, duplicate notifications, persistence, destination policy, SSRF/redirect restrictions, dependency/runtime packaging and resource measurements. Source-only prior inspection of those paths remains separate. Configure a dedicated non-sensitive readiness projection or authenticated private route; do not treat an Access login page's 200 as healthy. Alert delivery must remain operational evidence, not job approval or effect authority.

Estimated work remains a small observation/config adapter plus controlled separate-service packaging; there is no measured line-count deletion or production memory claim. Existing health schema validation stays. No native SQLite, real accounts, existing listeners, production database, notification delivery, deployment or GitHub writes were performed.

## Acquisitions and cleanup

Disk checked before download: about 140 GiB free. Exact owned root `/private/tmp/cr-f8-http.4Yid4F`; selected source plus temporary dependency tree/cache totaled 14 MiB, below 25 MiB allowance. Registry acquisition used private cache, `/dev/null` user config, `--ignore-scripts --no-audit --no-fund`; no repository dependencies changed. Root package license does not establish whole dependency closure; receipt lists installed manifest licenses, not legal clearance.

Source URLs are `https://raw.githubusercontent.com/louislam/uptime-kuma/e4821321e559c887b14e37d9979e604b221a8945/` plus `server/model/monitor.js`, `src/util.ts`, `server/util-server.js`, `package.json`, `package-lock.json`. Source hashes and selected registry artifact identities are retained; third-party source is temporary research material only, not newly shipped code.

Cleanup complete: the exact owned root `/private/tmp/cr-f8-http.4Yid4F` and its 14 MiB temporary source/dependencies/cache were removed after retaining this report and acquisition receipt. Re-download pinned sources/dependencies to reproduce. Both successful loopback server handles closed in `finally`; no persistent service was installed. Preliminary `f8-http-response-fit.ts` remains a clearly marked synthetic classifier-only diagnostic and must not be conflated with the real transport harness.
