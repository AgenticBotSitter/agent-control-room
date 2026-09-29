# Hermes macOS release-sidecar custody

**Status:** source-only, blocked contract. No Hermes process, credential,
profile, protected value, model call, runtime image, native helper, service or
installation was opened or created by this package.

## Decision

The current Hermes 0.21.3 runner cannot safely become the installed launch
route by adding another check around its absolute pathname. Node ultimately
reopens that pathname for `spawn`. The existing macOS negative-evidence probe
shows that suspended-process observation detects replacement with another
inode, but not same-inode byte mutation; a script also maps its interpreter
rather than the reviewed script. Hermes additionally loads Python code after
process creation. Rechecking the command immediately before launch therefore
does not close the custody gap.

The smallest safe route is a separately versioned macOS release sidecar, using
the same outer release binding as the existing native sidecars. It contains:

1. a complete, unmodified Hermes 0.21.3 runtime closure in a verified read-only
   runtime image, excluding credentials, profiles and private configuration;
2. a native launch host whose protocol and exact source/artifact bytes are
   bound by the sidecar manifest; and
3. license and notice material for every redistributed runtime component.

The native host may launch only the fixed internal entry from the verified
read-only image. It accepts no executable path, runtime path, command lookup,
profile, model, provider, work folder, credential or browser assertion. The
private installed host supplies those operational settings separately after
consuming a one-use release capability. Hermes source is not patched.

`macos-hermes-cli-release-sidecar-contract.ts` fixes that shape now. Its digest
fields are expected release pins, not provenance. The returned record is
always `contract_only`, carries every remaining blocker, performs no native
attempt and grants neither launch nor qualification authority. A caller-built
look-alike can at most reproduce a blocked planning record.

The source now also contains a pure runtime-image inventory manifest builder
and verifier. It records only normalized relative paths, entry kinds, safe
read-only modes, byte counts and content digests. It stores no absolute paths,
owner identity or timestamps. Formation and later verification both require an
exact entry set and refuse links, special files, hard-linked regular files,
writable modes, unsafe names, missing parent directories, duplicates, missing
entries and extra entries. The result remains `inventory_only`: it does not
walk a live installation, read file contents, prove that credentials are
absent, create an image or grant packaging or launch authority.

A separate build-time candidate inspector can now inspect only a supplied,
disposable public runtime directory and feed its observations into that same
manifest. It refuses links, special or writable entries, hard links,
unreviewed paths, missing `LICENSE` or `NOTICE`, `/nix/store/` references, and
all native Mach-O binaries (including universal binaries). Raw byte scanning
cannot prove a native library closure, so no native binary is accepted until a
separately reviewed dependency validator exists. It retains neither absolute
paths nor file contents, creates no image, and grants neither packaging nor
launch authority.

A separate source-only Mach-O parser now records a digest for a deliberately
minimal, supplied thin-image graph. It rejects ordinary real-image load
commands as well as universal images and performs no filesystem lookup. It
does not change the candidate inspector, establish custody, or clear the
`native_library_closure_unproven` blocker; a complete real native-image
closure review remains required before any native candidate is accepted.

The exact pinned public source has now also been reviewed and a pure import
policy added. It binds `hermes_cli.main:main`, CPython 3.11, architecture,
isolated bootstrap/module roots and the future dependency, native-library and
license inventories. The policy refuses external roots, import hooks, plugins,
bootstrap installation and private material. The reviewed source is marked
incompatible because startup mutates `sys.path`, may repair or install
dependencies, installs a meta-path hook and discovers plugins. The policy is
not a workaround and grants no authority.

## Upstream packaging reuse decision

The pinned Hermes source already contains a locked Nix packaging recipe. Its
dependency lock, wheel preference, Apple Silicon adjustments, package-data
rules and asset separation are useful build inputs and must be retained as
evidence for a future candidate runtime. Its published `minimal` output is
**not** a suitable Control Room runtime: it still builds the broad `all`
dependency group, includes desktop/server tooling, uses Python 3.12, and
depends on absolute `/nix/store` links and wrappers. Copying it would violate
the Control Room rule that the installed worker has no mutable or external
runtime paths.

Control Room will therefore reuse the pinned recipe and lock to construct or
evaluate a separately portable, text-worker-only candidate. It will not spoof
the upstream Nix-build flag to produce an ordinary wheel, dereference Nix
links opportunistically, or build a general Nix relocation system. A
build-time candidate inspector must reject links, external store references,
unbundled native-library references, unsafe modes and missing notices before
the existing exact runtime-image manifest can record the candidate.

## Required source work before any live attempt

Control Room must still:

1. build and independently review the native launch host, including complete
   process-group cleanup and helper-loss behavior;
2. resolve the recorded upstream import-policy incompatibility without
   modifying Hermes source, define the reviewed public-runtime inclusion list,
   then implement the owner-authorized packager that captures the complete
   interpreter and Hermes dependency closure, verifies license material and
   proves credentials are absent before feeding observations into the
   deterministic inventory;
3. add artifact verification and copy logic to the macOS launcher bundle, bind
   all bytes to the portable release, and extend protected installed-manifest
   custody with a one-use Hermes sidecar capability;
4. replace the current path-based private Hermes spawn with that concrete
   capability without exposing a helper path or a caller-supplied native port;
5. test pathname replacement, same-file mutation, altered interpreter/module,
   extra/missing runtime files, writable image, wrong architecture/release,
   helper loss, descendant cleanup, replay and structural-capability forgery;
   and
6. obtain independent security review of the native custody package.

Until every item exists, `pinnedExecutableLaunchSupported` remains false and
the installed route must refuse before starting Hermes.

## Exact owner and live prerequisites

The owner must later give separate, scoped authority to inspect and package
the public runtime closure of the existing Hermes installation. That capture
must not read or copy credentials, protected values, profiles, memories,
skills or private configuration. Any download, install, administrator action,
read-only image attachment, operating-system prompt or persistent-service
change requires its own owner approval.

Before that authorization is requested, release engineering must resolve the
blocked upstream startup behaviour, then settle and review the exact
public-runtime inclusion list. The entry point is now known but is not safe to
launch under the sealed policy. The future capture helper—not either pure
policy/manifest module—must
enforce that list while it reads the public runtime, scan the selected closure
for forbidden private material, include the applicable license notices, build
the read-only image and independently verify its digest. This is the exact
owner-bound next step; no live Hermes data needs to be inspected to finish the
remaining source design and tests around it.

After the reviewed sidecar is shipped, the owner must install its exact
architecture-specific bytes into the protected Control Room installation,
select the private profile/model/provider/work folder, and attend one new
bounded text-only qualification through the sidecar. The earlier path-based
qualification cannot qualify this changed launch route. The owner then makes a
separate enablement decision and separately authorizes the first harmless real
task.

The live attempt also requires the exact Hermes 0.21.3 source revision, a
matching macOS 13-or-newer architecture, compatible existing Hermes
authentication resolved by Hermes itself, the completed Control Room database,
protected-result/recovery and healthy-service gates, and a materialized
installed manifest binding the portable release and sidecar. Failure or an
uncertain reply is retained for owner attention and is never retried
automatically.
