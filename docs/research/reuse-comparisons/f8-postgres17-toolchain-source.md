# RC9 PostgreSQL17 isolated toolchain: source acquisition decision

2026-09-09 UTC. **Prefer inspecting the single-PG17 Postgres.app distribution,
not its five-version download or a manually relocated Homebrew bottle tree.**
This is a source-supported acquisition recommendation for root, not permission to
download, execute or start a database. Nothing was installed or run.

The current app requires PostgreSQL17, as established in
`f8-postgres-restore-preflight.md`. This Mac reports arm64/macOS26.6.2.
Postgres.app's published universal package includes arm64 and documents macOS10.15
minimum. Actual extracted architectures and runtime compatibility still require
inspection; platform labels are not execution evidence.

## Exact published choices

[Postgres.app release v2.9.6](https://github.com/PostgresApp/PostgresApp/releases/tag/v2.9.6)
reports PostgreSQL17.11/PostGIS3.5.6. The tag resolves directly to commit
`0e7a7084f7467ceacbaf757019b6e9bb1fb5ab7d`, not an assumed release branch.

| Asset | Published archive bytes | Published SHA256 |
| --- | ---: | --- |
| `Postgres-2.9.6-17.dmg` | 119,621,638 | `b38bb00b8c8702a568270aab85995c550f7f93d1503b818efdc5ff9a519b7168` |
| `Postgres-2.9.6-14-15-16-17-18.dmg` | 532,978,656 | `ee67776540fb0d29cbd119ea4db4cac3c182349ed53048fdf79766a588ac86b3` |

The [single-PG17 asset](https://github.com/PostgresApp/PostgresApp/releases/download/v2.9.6/Postgres-2.9.6-17.dmg)
is about114.1MiB; the multi-version package about508.3MiB. Single-major saves
413,357,018 archive bytes without omitting the selected17 server/client tools.
These are published compressed archive sizes, not extracted disk/RAM measurements.
GitHub marks this release `immutable:false`; pin the asset digest, not just its URL.

The [official CLI documentation](https://postgresapp.com/documentation/cli-tools.html)
lists postgres/initdb/pg_ctl/pg_dump/pg_restore/psql. More decisively, pinned
`Postgres/CopyBinaries.sh` copies initdb, postgres, psql and `pg_*`, all versioned
dylibs, PostgreSQL modules, include/share data. It preserves the complete major
version tree. Do not extract only three executable files or copy a system libpq.
The exact downloaded contents still need an inventory check after authorization.

## Why the app bundle can plausibly remain isolated

The PG17 makefile initially builds under `/Applications/Postgres.app/.../17`.
Stopping that inspection there would incorrectly suggest it cannot relocate.
The **final pinned CopyBinaries.sh explicitly rewrites internal dependencies to
`@loader_path`** for executables and nested libraries. The Xcode build invokes
that script. It then re-signs the resulting bundle in `buildscripts/01-build.sh`.
Thus source supports preserving the complete extracted `.app` tree under an
owned directory and using absolute `Contents/Versions/17/bin/...` paths, without
copying it into Applications or editing global PATH.

This is not proven binary relocatability yet. Before any executable runs, inspect
the downloaded tree and Mach-O dependencies for **each selected tool and recursively
required dylib**: arm64 slice present; internal loader paths remain inside the
owned version tree; external references are approved macOS system libraries, not
Homebrew, build-host paths or a live Postgres.app. Verify required share data is
discoverable from that layout. Do not automatically patch binaries, strip
signatures, set broad DYLD overrides or install a symlink in Applications.

The source makefile pins PostgreSQL17.11 plus native dependencies including
OpenSSL3.5.7, ICU75.1, LZ4 1.10.0, Zstd1.5.7, libxml2 2.13.9 and libxslt1.1.43.
Many additional PostGIS/extension dependencies are present. Its checks look for
both arm64/x86_64 and unwanted `/local`, `/opt`, build paths before packaging.
These are provenance/check definitions, not results we executed. Actual selected
tool dylib closure remains a download-time fact. Optional Python/PostGIS libraries
must not be confused with mandatory pg_dump runtime dependencies.

## Published integrity and signature evidence

- GitHub release asset metadata publishes the exact SHA256 above.
- Pinned `docs/sparkle/updates_17.xml` names the same119,621,638-byte DMG and publishes
  legacy Sparkle DSA signature `MCwCFE8ZNIusPdLbwydAXnRh0loRV6aAAhRDpGEp8mQeLnvtLC1YVwNb6q9/Mg==`.
- `Postgres/Info.plist` references `dsa_pub.pem`; the pinned public key was read,
  SHA256 `5237674584d45e1ee3654ce8ec1003994b449c257f7e676ff545643bbfa73c0c`.
- Actual release scripts sign binaries/bundle with Developer ID hardened runtime,
  submit the DMG to Apple's notarization service and staple the result. Source
  does not expose an exact fixed signer identity/Team ID; it selects a local
  Developer ID certificate. **No signature, certificate chain or notarization
  ticket was verified in this task.** A published digest plus build script is not
  a verified signed download.

Root should require digest matching, package signature/signer/ticket inspection
and exact library inventory before deciding whether to run the isolated tools.
No owner Keychain credential, signing key or app startup is needed for these
read-only package checks. Do not run upstream build/notarize scripts: they use
developer credentials and perform writes/builds unrelated to this evaluation.

Postgres.app's root PostgreSQL license was read. Bundled extensions/native
dependencies have separate licenses; the bundle root notice is not full third-party
distribution clearance. This is disposable research tooling, not inclusion in the
Control Room distributable.

## Homebrew17 alternative: real, but more relocation work

The [official formula metadata](https://formulae.brew.sh/api/formula/postgresql@17.json)
and matching source at homebrew-core commit
`c6bf5b32ffa8aea22b82a7241a2ebc6873c628cc` specify PostgreSQL17.11, revision0.
Formula SHA256 `7df68c8ed14eab1f5b721b96ef988530de1b7d743dc84df4521668cc0fb3e714`.
The matching arm64 Tahoe bottle is:

`https://ghcr.io/v2/homebrew/core/postgresql/17/blobs/sha256:1fbc3c17f3da21f29363a6a942aa9db176e5d808d2c39e86f225ee9f665147db`

Its SHA256 is the digest in that URL. Sequoia/Sonoma variants are separately
published; they are not interchangeable hashes. No bottle archive or size was
requested, so Homebrew is not declared smaller by measured bytes.

Crucially, PostgreSQL17's bottle cellar is `/opt/homebrew/Cellar`, not `:any` or
`:any_skip_relocation`. Formula install code deliberately uses Cellar install names
and prefix-based share/lib/include paths. Its post-install steps link global paths
and initialize a default cluster; a normal `brew install` is outside this request.
[Homebrew's bottle documentation](https://docs.brew.sh/Bottles) explicitly distinguishes
relocatable bottles from fixed Cellar builds. Merely untarring this bottle into
`/private/tmp` does not establish a working isolated toolchain.

Declared recursive macOS dependency metadata was inspected at the same source pin:
ICU78.3, krb5 1.22.2, LZ4 1.10.0, OpenSSL3.6.4, readline8.3.3, Zstd1.5.7 revision1,
gettext1.0, ca-certificates2026-08-13, xz5.8.3, json-c0.19 and libunistring1.4.2.
Exact platform bottle URLs/digests/licenses are in the receipt (the universal
ca-certificates bottle was not included by the platform filter; its exact artifact
remains unresolved). krb5/OpenSSL/gettext also report fixed Cellars. System-library
dependencies include libxml2/libxslt/openldap/Perl/ncurses and selected others.
This is declared package closure, not actual Mach-O reachability of only restore
tools. License metadata includes GPL/LGPL/mixed expressions; no simplistic
PostgreSQL-only license conclusion is supported.

An isolated Homebrew route would need exact bottle dependency acquisition,
inspection, relocation of all applicable library/data/config paths, signature
handling and owned-root prefix emulation without post-install/global effects.
That is possible engineering, not a reason to reject Homebrew generally—but it
adds work already performed inside Postgres.app's packaging. Do not author that
replacement installer unless the signed single-PG17 bundle fails the actual check.

## Bounded next step and evidence limits

Root can choose the single-PG17 DMG for a separate bounded acquisition/inspection
packet: check free disk, bound compressed and extracted sizes, verify published
hash/signature, inspect contents/symlinks/Mach-O closure, retain signed bundle shape.
Do not launch the GUI, register/login-item/update helper, run initdb, create a
listener, or touch existing databases during that acquisition. DMG mounting or an
alternate extractor needs its own explicit reviewed effect/cleanup scope; this
task performed neither. Only after successful inspection should root authorize
the disposable native-tool/version and logical-restore experiment.

Public responses were memory-only:30 exact receipts totaling449,552 decoded bytes.
One first four-response batch suffered tool-output truncation/JSON parsing failure;
its exact per-response receipt was unavailable. Conservatively charging its full
enforced300,000-byte ceiling gives749,552 bytes, still below3MiB. One corrected
filtered-output source reread is recorded, not hidden. No claimed binary byte
inspection or signature execution occurred. No source cache/temp directory was
created; only this authored report and receipt remain. Root chooses acquisition.
