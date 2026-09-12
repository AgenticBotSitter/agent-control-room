# PostgreSQL17 package inspection checkpoint

2026-09-08. Acquired pinned Postgres.app2.9.6 single-PG17 DMG, exact119,621,638 bytes
and published SHA256 verified. Download provenance is in f8-pg17-acquisition-evidence.json.
No package binary or GUI was launched; no installation/database/listener/service.

The owned DMG was temporarily mounted read-only, nobrowse/noautoopen, under its
exact logged root. hdiutil verified image checksums. System codesign deep/strict
verification returned0 and reported valid on disk/designated requirement satisfied.
Displayed signer was Developer ID Application Jakob Egger, TeamZF84SJ5A3G, with
Apple certificate chain. This is actual package signature inspection, not merely
a source build-script claim. Independent signer provenance and notarization ticket
assessment remain distinct; no owner Keychain or signing credential was accessed.

All six required tools (postgres, initdb, pg_ctl, pg_dump, pg_restore, psql) are
present and contain arm64/x86_64 slices. Their direct library references are internal
@loader_path libraries or macOS system libraries. Actual recursive dylib closure,
per-tool signed-code verification, share-data location and isolated runtime version
checks remain before a disposable restore experiment. Do not treat direct-library
inspection as proof of full relocation or copy only executable files.

The complete mounted bundle measured403,504KiB. No extracted copy was made. The
read-only mount was successfully detached (hdiutil exit0); the disk image and local
acquisition/inspection receipts remain in /private/tmp/cr-f8-pg17.2FlFtD. No live
process handle remains. Exact command/results are retained in inspection evidence;
future cleanup may remove only that owned root after checking for mounts/processes.

This is progress toward real PG17 dump/restore testing, not a restore pass. It avoids
a custom Homebrew relocation/install workflow while preserving signature provenance.
