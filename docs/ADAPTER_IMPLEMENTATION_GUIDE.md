# Project adapter implementation guide

## Goal

A future project can join Control Room without copying Wayfarer or Content Blooms. Implement the versioned adapter at the project boundary, publish sanitized operational projections, and declare which commands and scheduling authority the project supports.

## Required manifest

Expose a manifest declaring:

- adapter and source-system IDs;
- contract version `control-room-project-adapter/v1`;
- authority mode;
- project types;
- supported read operations and commands;
- opaque cursor retention;
- redaction-policy version.

## Expected read endpoints

The canonical HTTP mapping is:

| Operation | Endpoint |
|---|---|
| Manifest | `GET /api/control-room/v1/manifest` |
| Project summary | `GET /api/control-room/v1/project-summary` |
| Work items | `GET /api/control-room/v1/work-items?cursor=&state=&limit=` |
| Executions | `GET /api/control-room/v1/executions?cursor=&state=&limit=` |
| Blockers | `GET /api/control-room/v1/blockers?cursor=&limit=` |
| Project-visible workers | `GET /api/control-room/v1/workers` |
| Attention items | `GET /api/control-room/v1/attention-items?cursor=&limit=` |
| Append-only changes | `GET /api/control-room/v1/changes?after=&limit=` |

All responses use HTTPS, the adapter service credential, schema validation, bounded page sizes, safe error codes, and an opaque next cursor. Deep links point to protected source screens and must not contain signed media URLs or private payloads.

## Optional future command endpoints

Not used before live integration approval:

- `POST /api/control-room/v1/commands/retry`
- `POST /api/control-room/v1/commands/priority`
- `POST /api/control-room/v1/commands/worker-preference`
- `POST /api/control-room/v1/commands/pause`
- `POST /api/control-room/v1/commands/resume`
- `POST /api/control-room/v1/commands/decision`

The source validates authority and performs the transition. Control Room never edits a source product's workflow tables.

## Capability and route modeling

Do not project “can transcribe” as a single boolean. Publish safe route choices such as:

- `transcription.whisper.mlx` on a Mac;
- `transcription.whisper.cuda` on a Windows GPU;
- `transcription.whisper.cpu` on a VPS;
- an approved provider route.

Each route can carry a verification state, benchmark version/time, expected duration, estimated cost, quality class, and privacy class. The project still decides whether a route is certified for a specific tenant or workload.

## Minimum adapter tests

- contract/schema compatibility;
- stable source references and monotonically advancing cursor;
- repeated-page idempotency;
- tenant/workspace isolation;
- forbidden-content and log-redaction rejection;
- offline/timeout behavior;
- version mismatch behavior;
- unsupported-command rejection;
- deep links contain no signed credentials.
