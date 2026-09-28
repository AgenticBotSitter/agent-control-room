# Multi-client load test — policy: before (existing setInterval polling)

- simulated clients: 10 (3 active, 7 background tabs)
- duration: 120s
- injected per-query latency: 50ms (remote database)
- database queries issued: 20
- background-tab requests during the run: 0 (expected 0 — hidden tabs must not poll)

| endpoint | reads | p50 ms | p95 ms | max ms |
| --- | ---: | ---: | ---: | ---: |
| /api/v1/connections (return-to-tab) | 2 | 56 | 61 | 61 |
| /api/v1/home/tasks (return-to-tab) | 1 | 68 | 68 | 68 |
| /api/v1/home/tasks | 4 | 65 | 80 | 80 |
| /api/v1/needs-me/tasks (return-to-tab) | 1 | 58 | 58 | 58 |
| /api/v1/needs-me/tasks | 4 | 68 | 69 | 69 |
| /api/v1/operator-surface (return-to-tab) | 1 | 67 | 67 | 67 |
| /api/v1/projects (return-to-tab) | 2 | 60 | 60 | 60 |
| /api/v1/projects | 5 | 69 | 72 | 72 |

| status | count |
| --- | ---: |
| /api/v1/connections (return-to-tab) 200 | 2 |
| /api/v1/home/tasks (return-to-tab) 200 | 1 |
| /api/v1/home/tasks 200 | 1 |
| /api/v1/home/tasks 304 | 3 |
| /api/v1/needs-me/tasks (return-to-tab) 200 | 1 |
| /api/v1/needs-me/tasks 200 | 1 |
| /api/v1/needs-me/tasks 304 | 3 |
| /api/v1/operator-surface (return-to-tab) 200 | 1 |
| /api/v1/projects (return-to-tab) 200 | 2 |
| /api/v1/projects 200 | 1 |
| /api/v1/projects 304 | 4 |

- 304 Not Modified responses: 10
- unavailable responses (4xx/5xx): 0
- worst p95 across endpoints: 80ms

Acceptance: zero unavailable — PASS (allowed 0)

Acceptance: p95 < 1500ms — PASS (80ms)

Result: PASS
