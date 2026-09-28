# Multi-client load test — policy: after (polling discipline + conditional reads)

- simulated clients: 10 (3 active, 7 background tabs)
- duration: 120s
- injected per-query latency: 50ms (remote database)
- database queries issued: 17
- background-tab requests during the run: 0 (expected 0 — hidden tabs must not poll)

| endpoint | reads | p50 ms | p95 ms | max ms |
| --- | ---: | ---: | ---: | ---: |
| /api/v1/connections (return-to-tab) | 2 | 58 | 62 | 62 |
| /api/v1/home/tasks (return-to-tab) | 1 | 69 | 69 | 69 |
| /api/v1/home/tasks | 3 | 62 | 80 | 80 |
| /api/v1/needs-me/tasks (return-to-tab) | 1 | 61 | 61 | 61 |
| /api/v1/needs-me/tasks | 3 | 63 | 69 | 69 |
| /api/v1/operator-surface (return-to-tab) | 1 | 67 | 67 | 67 |
| /api/v1/projects (return-to-tab) | 2 | 57 | 60 | 60 |
| /api/v1/projects | 4 | 62 | 70 | 70 |

| status | count |
| --- | ---: |
| /api/v1/connections (return-to-tab) 200 | 2 |
| /api/v1/home/tasks (return-to-tab) 200 | 1 |
| /api/v1/home/tasks 200 | 1 |
| /api/v1/home/tasks 304 | 2 |
| /api/v1/needs-me/tasks (return-to-tab) 200 | 1 |
| /api/v1/needs-me/tasks 200 | 1 |
| /api/v1/needs-me/tasks 304 | 2 |
| /api/v1/operator-surface (return-to-tab) 200 | 1 |
| /api/v1/projects (return-to-tab) 200 | 2 |
| /api/v1/projects 200 | 1 |
| /api/v1/projects 304 | 3 |

- 304 Not Modified responses: 7
- bytes transferred on 200 responses: 3795 (mean 380 per response)
- bytes transferred on 304 responses: 0 (a 304 carries no body)
- response bytes actually avoided by the 7 conditional reads (sum of each matching 200 representation): 1161
- unavailable responses (4xx/5xx): 0
- worst p95 across endpoints: 80ms

Acceptance: zero unavailable — PASS (allowed 0)

Acceptance: p95 < 1500ms — PASS (80ms)

Result: PASS
