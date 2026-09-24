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

## Required source work before any live attempt

Control Room must still:

1. build and independently review the native launch host, including complete
   process-group cleanup and helper-loss behavior;
2. define a deterministic, licensed runtime-image builder that inventories
   the complete interpreter and Hermes dependency closure, rejects links,
   special files and unlisted entries, and proves credentials are absent;
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
