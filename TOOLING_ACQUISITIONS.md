# Local tooling acquisition log

## macOS Codex process-acquisition fit decision — 2026-09-13

- Purpose: determine whether a maintained component could provide the same held
  executable, workspace and `CODEX_HOME` guarantees as the reviewed Linux launcher.
- Decision: do not add a Darwin launcher to the first release. Qualify Codex execution
  on Linux; keep local macOS Codex execution fail-closed under issue #191.
- Apple documents `POSIX_SPAWN_START_SUSPENDED`, PID-based running-code lookup and
  code-validity checks, so a later owner-authorized harmless spike may prove an exact
  executable before user code runs. Darwin `/dev/fd` does not provide the Linux
  traversable-directory behavior needed for the protected workspace and `CODEX_HOME`.
- `swift-subprocess` 1.0.0 is maintained and Apache-2.0 and provides useful spawn,
  pipe and termination plumbing. It does not verify running code or bind Codex's
  pathname-based `CODEX_HOME`; adding a Swift helper would therefore add build,
  signing and IPC work without closing the decisive race. It was not selected or added.
- launchd, SMAppService and XPC may later supervise a signed helper, but do not provide
  this per-attempt pipe-owned child plus held home-directory contract.
- Reopen only after both are proven: an owner-authorized harmless suspended-spawn plus
  running-code identity check before user code, and a supported inherited protected
  home-directory handle accepted by Codex or the selected runtime.
- Primary references: [Apple spawn flags](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man3/posix_spawnattr_getflags.3.html),
  [Security.framework running-code lookup](https://developer.apple.com/documentation/security/seccodecopyguestwithattributes(_:_:_:_:)),
  [code validity](https://developer.apple.com/documentation/security/seccodecheckvalidity(_:_:_:)),
  [Darwin fdesc implementation](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/miscfs/devfs/devfs_fdesc_support.c),
  [`swift-subprocess` 1.0.0](https://github.com/swiftlang/swift-subprocess/releases/tag/1.0.0),
  and the [official Codex signed/notarized macOS release workflow](https://github.com/openai/codex/blob/5b1d6560181680f95cde95c14ed042acc02248ed/.github/workflows/rust-release.yml#L604-L717).
- Effects: source and documentation review only. No package, helper, binary, credential,
  provider call, native process, service or deployment was used.

## Codex TypeScript SDK fit evaluation — 2026-09-13

- Downloaded one isolated npm archive for `@openai/codex-sdk@0.154.0` into a
  temporary directory after confirming approximately 118 GiB free space.
- Archive size: 21,186 bytes. SHA-256:
  `1b64f9731c03838062c6ec4ea8374bffd17fe9b7a79aafe9115263e94b1c1f05`.
- Purpose: check whether the current official SDK can replace the existing
  App Server connector before adding more custom process code.
- Decision: do not replace the MVP App Server path. Keep the SDK as a deferred
  optional batch-job adapter because it lacks the exact passive turn-read and
  interactive approval surfaces required by Control Room.
- Retained repository evidence:
  `research/codex-sdk-0.154.0-fit-evidence.json`. No SDK code, archive or
  dependency is retained in the repository.
- Temporary directory pattern: `/private/tmp/acr-codex-sdk-eval.<temporary-id>`;
  remove the exact tracked local directory after
  the decision commit is reviewed. The archive is not needed after that point.
- The SDK depends on current `@openai/codex@0.154.0`. Its 4,902-byte package
  archive and 116,501,639-byte Mac ARM64 archive were also downloaded only to
  pin the candidate identity. SHA-256 values are retained in the evidence file.
  The binary was not extracted or run. Replacing the existing
  `0.150.0-alpha.8` pin requires a separately authorized schema-generation and
  compatibility review.
- Network/provider effects: npm package download only. No install, Codex process,
  credential access, provider call, thread, turn, plugin, MCP server or deployment.

## Codex App Server start-schema evidence — 2026-09-12

- Requested package: `@openai/codex@0.150.0-alpha.8` with its selected
  `0.150.0-alpha.8-darwin-arm64` platform artifact.
- Purpose: generate the non-experimental App Server schemas locally and retain
  only sanitized facts for `thread/start` and `turn/start`.
- Free space before acquisition: approximately 106 GiB on the local data volume.
- Temporary size: approximately 412 MiB, including the isolated npm cache and
  generated schema bundle.
- Network/provider effects: package acquisition only. No provider call, thread,
  turn, credential inspection, plugin, MCP server or production effect occurred.
- Retained: bounded package/version, schema file sizes and SHA-256 values,
  required start fields, and explicit scope limitations in
  `research/codex-app-server-0.150.0-alpha.8-start-schema-evidence.json`.
- Cleanup: the isolated cache, package runtime and full generated schemas were
  removed after the retained evidence and its tests passed. Nothing from this
  acquisition is needed at runtime.

## saxes 6.0.0 original notice — 2026-09-09

Downloaded only LICENSE (3011 bytes) and package.json from public commit
`211fa0ebec9b628affc09219199639887174bfc3`, after resolving the v6.0.0 annotated
tag. Retained under third_party/saxes; exact URLs and evidence are in PROVENANCE.md.
No archive, package installation or executable code was downloaded in this step.
These two files are retained as required attribution evidence; remove only if
the dependency is removed and the affected distribution no longer includes it.
Available storage remains approximately 137 GiB. No temporary download files remain.

## CycloneDX runtime notice assembly — 2026-09-09

- Requested package: `@cyclonedx/cyclonedx-library@10.2.0`, selected DR-04 library.
- Purpose: build-time original-license attachment collection, not application runtime.
- Free space before attempt: approximately 137 GiB on the local data volume.
- Final operation: pinned dev dependency, install scripts disabled, original
  project peer-resolution policy preserved. Optional AJV reuses the existing pin.
- Status: installed successfully. Package and lock add only the selected library;
  final lock diff is 34 added lines, with no previous package entries changed.
- Actual collector implementation SHA256:
  `10a3bc2b7855dcfe85e8f3943d8bd2c512875d2cded34bc7df9ab51544891b36`, matching evaluated source.
- Attempt history: default store selection refused; offline original-store access
  failed; scoped original-store installation succeeded (1 downloaded package).
  Disabling automatic peers caused unrelated removals. Restoring default resolution
  then fetched 4 transient packages and selected incidental webpack/minifier upgrades.
  Restoring the original lock with a targeted patch and repeating the add retained
  all original dependency pins, with zero further downloads. Transient shared-cache
  objects were not deleted; their exact cache inventory still requires reconciliation
  before cleanup. This is not a claim that all acquisition cleanup is finished.
- Retention: while notice assembly uses this selected library. If rejected, remove
  the explicit dev dependency through pnpm and regenerate the lockfile; do not
  delete the shared package cache or unrelated dependencies. Record outcome here.
- Do not treat this log as a complete historical inventory of earlier research
  downloads. Earlier research retains its own acquisition/cleanup receipts.
