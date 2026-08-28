# Control Room Codex isolated macOS package

This package is a static, effect-free deployment candidate for the CR-7B disposable native qualification. It does not create users, render or install launchd files, start processes, change permissions or network rules, access authentication, or make a provider call.

## Roles

- `broker/com.control-room.codex-broker.plist.template` is a per-login LaunchAgent template for the credential-owning broker controller. The controller owns the Codex app-server child through stdin/stdout. It must not listen for app-server clients.
- `executor/com.control-room.codex-executor.plist.template` is a system LaunchDaemon template for a dedicated, non-admin, credential-free executor identity. It runs only the pinned `exec-server`, accepts one request at a time, and listens only on a rendered loopback endpoint.

The broker release, configuration, credential, and state roots must be separated from each other and from the executor `CODEX_HOME` and workspace. The durable replay ledger belongs in broker state, never in the credential root. The executor must be unable to read or change any broker-owned root and must have no provider egress.

## Template handling

All `{{CONTROL_ROOM_CODEX_*}}` values are required render-time inputs. Rendering must reject missing placeholders, relative paths, a non-loopback endpoint, overlapping roots, an unpinned executable, or reused broker/executor identities. Rendered files are host-local deployment artifacts and must not be committed.

The repository conformance check validates the static templates only. Passing it does not prove native account separation, filesystem permissions, network policy, process identity, service operation, or credential isolation.

## Stop points

Separate owner approval is required before each material native stage: creating or changing an OS identity; writing host configuration; installing or loading either service; changing filesystem permissions or network policy; accessing existing authentication; and making the disposable qualification provider calls. A failure stops the procedure and produces sanitized negative evidence. It is never repaired by weakening isolation or copying broker authentication into the executor.

See `docs/CR7B_MACOS_ISOLATED_SETUP.md` for the staged acceptance procedure.
