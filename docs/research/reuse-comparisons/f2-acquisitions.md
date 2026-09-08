# F2 runtime interface acquisition ledger

2026-09-08, baseline3b7588b. Comparison-goal scope, no native agent/provider calls.
Owned root /private/tmp/cr-compare-f2.Dz7yHK; source/dependency cap100MiB for this
cohort, within global4GiB. Last disk check140GiB free; repeat before large acquisition.
Official App Server and SDK pages searched and opened via OpenAI Docs workflow.
Planned selected pinned public Codex SDK source/schema/test files, no executable
installation. Any actual SDK experiment must use a synthetic execution seam and
must not discover an installed executable or touch ambient credentials/profiles.

## Acquired and exercised

Registry archive: `https://registry.npmjs.org/@openai/codex-sdk/-/codex-sdk-0.153.4.tgz`,
21,186 bytes, six extracted package files (79,412 unpacked bytes). No dependency
installation; the declared `@openai/codex` executable dependency was not acquired.
Archive SHA-512:
`cf4acdf16310c70107607a4327228767034d52d33fd69767c662a8a48277a8c099cb20deb2d688852183674bf44528e6f9112e8dc17235df79a16b3bf335a046`.
Extracted `package/dist/index.js` SHA-256:
`d62ed107033bdba802b283c77d875e4bec3deb2704a910bb7e3f95059473b16f`.
Both identities are checked before the harness imports the actual exported Thread.
Registry metadata supplied no release gitHead; do not equate the archive with main.

Selected raw source prefix:
`https://raw.githubusercontent.com/openai/codex/553df1c691fe8bf7747e50da22f1342984495ae0/`.

| Upstream path | Retained filename | SHA-256 |
| --- | --- | --- |
| `sdk/python/src/openai_codex/client.py` | `python-client.py` | `76bdb1e63c62987c3530ea763e9655a06b308cbc4e18cb51958e85b6c23aec3b` |
| `sdk/python/tests/test_client_rpc_methods.py` | `python-client-test.py` | `da00c06caafe56db3718dfdf06e3253f420d0c9a7cc7c4e4c82c0e462c86a65a` |
| `sdk/typescript/tests/runStreamed.test.ts` | `typescript-streamed-test.ts` | `80592f5f89ee33da8ec6e5676b6dced0af6847aa540795cfd5f3a6f88312fb3e` |
| `LICENSE` | `LICENSE` | `d17f227e4df5da1600391338865ce0f3055211760a36688f816941d58232d8dc` |

Public tree/registry metadata was inspected without retaining response files.
Actual SDK parser-to-Control Room experiment: eight checks passed. Selected actual
Python method-body experiment: four checks passed. Fake execution/router ports,
not native agent, provider, full Python package or process-lifecycle acceptance.

Checkpoint allocation: 184 KiB; disk remains 140 GiB free. Retained for reproducible
follow-up and review; cleanup is **not yet performed**. No F2 owned service or native
process was started. Remove only this exact owned root when comparisons no longer
need it, after preserving any additional receipts. No production files were imported.
