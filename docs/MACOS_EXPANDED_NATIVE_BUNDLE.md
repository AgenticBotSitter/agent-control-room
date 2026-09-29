# Expanded inert macOS launcher bundle

`assembleMacosLocalLauncherBundleV2` packages the portable release and all four reviewed native sidecars into one deterministic outer archive. It does not activate them. The existing `assembleMacosLocalLauncherBundleV1` and its exact 19-member layout remain supported.

The expanded schema is `control-room.macos-local-launcher-bundle/v2`. Its exact inventory is 31 files plus `MACOS_LAUNCHER_MANIFEST.json`: the legacy 19 files, two additional runtime verifier modules, four installed-configuration sidecar members, and six macOS-service sidecar members. The Finder command and `native/macos-service/macos-service-v1` are exactly mode `0755`; every other outer file is exactly `0644`, and directories are `0755`. The configuration helper remains inside its verified archive. Extra, missing, linked, renamed, modified, or inexact-mode members fail closed.

## Assembly inputs and bindings

The assembly CLI retains its five legacy absolute-path arguments. Supplying both `--installed-configuration-native-artifact-directory` and `--macos-service-native-artifact-directory` explicitly selects expanded v2; supplying only one is refused. The source, portable release, protected-directory, journal, configuration, and service artifacts must already exist. Assembly does not build or download them.

All four independently verified artifacts must share one architecture. Their identities are captured before temporary portable-release validation, then independently reverified during copying and compared. All sidecars bind the same release version. The service sidecar additionally binds the portable release manifest's `sha256:` identity, not the archive digest or outer manifest digest. Service source hashes use their existing prefixed contract; the other artifact contracts retain their existing representations.

The verifier and assembly report return `outerLauncherManifestSha256` and typed `protectedDirectoryNativeSidecar`, `installationJournalNativeSidecar`, `installedConfigurationNativeSidecar`, and `macosServiceNativeSidecar` summaries. The extracted launcher reports these separately and passes only the existing four-field verified-release contract to the shared launcher core. Lazy loading of the two added verifier modules preserves extracted legacy-v1 operation.

## Deliberately deferred authority

This package does not change installed manifest v2 or its journal-specific native-sidecar fields. Its existing `outerLauncherManifestSha256` can bind this expanded inventory transitively; this package does not write that protected manifest, add owner-host inputs, or mint a provider.

A later fixed owner-host composition must first verify the outer manifest against its protected expected digest, then consume the independently verified sidecar pins. Only a separately authorized boundary may call `stageMacosInstalledConfigurationNativeFactoryInputV1` with the verified configuration archive, artifact, executable, sidecar, and release pins. The service factory must receive the verified fixed `native/macos-service/macos-service-v1` path and executable identity. It must not substitute a caller-selected runner or treat a returned summary as authority.

No configuration-native staging, native-helper execution, Keychain operation, launchctl call, database operation, recovery action, Claude/Hermes execution, service activation, signing, publication, or owner qualification occurs here. Existing source-only launcher preparation behavior remains unchanged. The tests use inert fixture bytes and injected source-only launcher processes; they are packaging evidence, not platform qualification or authenticated service-health evidence.

## Verification

The existing macOS bundle test file remains in its existing test lane. Coverage includes both exact layouts and extracted runtimes, deterministic archive bytes, all four sidecar summaries and release bindings, missing/substituted/mixed-architecture inputs, coherent wrong-release metadata, unsafe inventory/modes, refusal before owner-directory writes, and paired CLI selection. No new lane or live-host prerequisite is introduced.
