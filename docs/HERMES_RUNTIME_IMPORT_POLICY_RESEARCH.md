# Hermes runtime entry and import policy

Status: bounded public-source review and policy, 2026-09-24. No runtime was
captured or started; no Hermes installation, profile, authentication or
private data was inspected. This document does not establish a qualified
launcher.

## What is established

Control Room pins Hermes 0.21.3 at
`00570550f37e9082676955d50f65c7d9ba846cc9` in
`src/harness/hermes-021-v1/connector-profile.ts`. Its existing subprocess host
supplies a profile, work directory and a restricted tool selection. Those
arguments alone do not establish where Python or Hermes imports code from.

The exact public checkout at that revision was inspected without modification.
`pyproject.toml` fixes the `hermes` console script to
`hermes_cli.main:main`, declares Python `>=3.11,<3.14`, and the checked-in
`.python-version` selects 3.11. The same metadata declares MIT and ships
`LICENSE`; `uv.lock` is the dependency-resolution source, not permission to
install anything during image formation or startup.

That inspection found four incompatibilities with a sealed import boundary.
`hermes_cli/main.py` inserts the source root into `sys.path`; its import-time
early recovery can run `ensurepip`, `pip` or `uv`; `cli.py` installs a
`sys.meta_path` finder; and normal agent startup discovers bundled, user,
project and Python entry-point plugins. These are supported upstream
behaviours, not findings that Control Room may patch away. The current source
therefore does not satisfy the future sealed-runtime policy.

## Proposed release layout and startup policy

The release can define stable *packaging roles* now: interpreter, standard
library, extension modules, Hermes code/resources, dependencies, fixed bootstrap
and notices. The source review now fixes the Python ABI, callable and proposed
image-relative role paths; none is verified runtime-image evidence yet.

The source-only `macos-hermes-runtime-import-policy.ts` now records the exact
entry point, CPython 3.11 ABI, architecture, isolated bootstrap, image-relative
module roots and digest bindings for the runtime, dependency, native-library
and license inventories. It rejects caller-selected roots, hooks, plugins and
private paths and grants no image, process, install or qualification authority.
It deliberately records the pinned source as incompatible.

Use CPython's existing isolated initialization facilities, with an explicit
image-relative module search list resolved by the native host. Disable
environment-derived configuration, user-site loading, automatic `site`
initialization and bytecode writes. Pin interpreter home/prefix and executable
to the same image. `PyConfig_InitIsolatedConfig` and explicit
`module_search_paths_set` are candidates; select APIs supported by the captured
Python version, rather than requiring the new Python 3.14 API. See
[CPython initialization documentation](https://docs.python.org/3/c-api/init_config.html).

For a process-based bootstrap, `-I -S -B` is a candidate starting point, not a
complete import policy. `-I` ignores Python environment variables and excludes
the script/current directory and user-site location from the initial search
path; `-S` prevents automatic site initialization. Hermes/dependencies still
need deliberate image-only search paths. See
[Python command-line behavior](https://docs.python.org/3/using/cmdline.html).

Do not run `site.addsitedir` over dependency directories: `.pth` processing can
execute code. Editable-install hooks, `.egg-link`, external `.pth` targets,
`sitecustomize` and `usercustomize` need explicit exclusion or reviewed handling.
Retain required distribution metadata and resource files. See
[Python site initialization](https://docs.python.org/3/library/site.html).

Neither approach stops application code from changing `sys.path`, using an
explicit file loader, executing a profile hook or loading native code. Inspect
those paths in pinned Hermes before claiming work-directory/profile isolation.
The existing `--ignore-rules` and toolset arguments are not evidence that plugin
discovery is disabled. If upstream cannot disable external code loading through
a supported configuration, report that compatibility gap; do not silently patch
Hermes or claim Python flags solved it. Native-library dependency paths and
loader environment also need image/system-library-only review.

## Reuse and acceptance

Reuse unmodified Hermes plus its supported entry point, CPython initialization,
the existing runtime inventory verifier and native supervision protocol. Avoid
a custom Python import framework. Before enabling this route, disposable probes
must seed import traps in the work directory, user site, environment paths and
profile/plugin locations and prove none execute. Include a dependency that needs
metadata/resources so isolation does not merely break the runtime. Repeat after
changing work directory and with a native extension dependency.

The existing reuse register describes Hermes as MIT, but exact revision license
text still needs retrieval. Preserve Hermes notices and independently inventory
licenses for Python, its bundled native libraries and every dependency; the
application's Apache license does not replace those obligations. No upstream
code was copied by this research.

## Next implementation decision

### Restricted execution home preflight (September 24)

The additive `macos-hermes-restricted-home-preflight.ts` inspects supplied
inventories without touching a filesystem or starting Hermes. It reuses the
native-host input join and manifest verifier, requires the fixed Python/Hermes/
dependency roots and bootstrap files, and accepts an execution-home inventory
containing only optional empty `logs` and `sessions` directories. Profiles,
credentials, provider/plugin directories, symlinks and arbitrary home entries
are refused. Recovery markers and executable Python site hooks are refused in
the image inventory too. This describes a proposed fresh execution home; it
does not describe or inspect the owner's existing Hermes home.

Closer inspection of the exact cached source distinguishes two details that
the original blanket policy does not: `hermes_cli/main.py` computes its inserted
root from `realpath(parent(__file__))`, and `cli.py`'s `_AsyncHttpxDelNeuter`
finder targets only `openai._base_client`. An immutable image containing those
files can therefore describe that specific internal behavior without accepting
an arbitrary module root or arbitrary hook. `_early_recovery.py` checks the
source-root `.update-incomplete` and `.lazy-refresh-incomplete` markers before
repairing dependencies. Their absence matters, but supplied inventory absence
alone cannot prove they stay absent at runtime.

The preflight does **not** relax the existing import policy, certify file
contents from caller-supplied hashes, or declare launch readiness. Plugin
entry-point metadata, other dynamic loading, native filesystem custody and the
restricted home's real runtime behavior remain unproven. The pinned source's
MIT attribution remains upstream; no Python source was copied or modified.

### Additive sealed-runtime candidate (September 24)

`macos-hermes-sealed-runtime-candidate-policy.ts` records a separate, inert
candidate while preserving the original import policy and native-host input
contract. Its builder requires successful native-host and restricted-home
preflight joins and binds both resulting digests, the unchanged baseline
policy and its inventory digests. Parsing verifies a saved statement's
consistency, not custody or inventory possession. The candidate
hard-codes only two root mutations: `main.py`'s conditional realpath parent
insertion and `_startup_fast.py`'s `ensure_project_root_on_path`, which removes
realpath-equivalent entries and prepends the same `runtime/hermes` root.
The restricted-home preflight now also requires `_startup_fast.py` in its
supplied inventory.

The candidate describes only `cli.py`'s `_AsyncHttpxDelNeuter` finder for
`openai._base_client`: self-removal before ordinary resolution and replacement
of `AsyncHttpxClientWrapper.__del__`. Its required future resolved target is
exactly `runtime/dependencies/openai/_base_client.py`. No caller can choose
another root, finder, module or target, including by recalculating the digest.
These are source-review statements, not runtime enforcement or custody proof.

All image, process, install, qualification, launch and packaging authority
flags remain false. The candidate retains baseline incompatibility and
blockers for native filesystem custody, dependency repair, plugin entry points,
dynamic loading, native libraries, restricted-home runtime behavior and actual
hook-target resolution. The existing native-host contract refuses the candidate
as a substitute for its v1 import policy. Negative tests exercise altered
exceptions, forged digests, changed blockers and authority, and hostile data.

Before packaging can proceed, the unresolved compatibility and custody gaps
must be resolved through reviewed evidence; Control Room must not modify
Hermes source to make it fit.
Later inventory formation, capture of the existing runtime, image
creation/mounting and real qualification remain within the owner-authorized
capture/activation stage described in
`HERMES_MACOS_RELEASE_SIDECAR_CUSTODY.md`. No private Hermes data is needed to
retain or review this source finding.
