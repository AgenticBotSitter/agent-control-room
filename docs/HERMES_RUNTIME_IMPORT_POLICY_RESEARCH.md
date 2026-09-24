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

A candidate policy and negative test specification are now implemented. They
are a refusal boundary, not evidence that the fixed entry layout works. Before
packaging can proceed, upstream must provide a supported invocation mode that
avoids the four recorded incompatibilities, or architecture must explicitly
retain the gap; Control Room must not modify Hermes source to make it fit.
Later inventory formation, capture of the existing runtime, image
creation/mounting and real qualification remain within the owner-authorized
capture/activation stage described in
`HERMES_MACOS_RELEASE_SIDECAR_CUSTODY.md`. No private Hermes data is needed to
retain or review this source finding.
