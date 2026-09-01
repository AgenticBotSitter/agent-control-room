# CR12B-IDEA-110E — enrolled gateway second remediation

**Status:** Accepted for the exact provider-disabled snapshot by the second different independent re-review.

## Outcome

The first remediation re-review closed every original High finding and then found two new Medium boundary defects. This
block repairs both without changing the bridge method set, signed authority, provider budget, route behavior, or default
disabled state.

- The gateway constructor now snapshots one exact ordinary-data wrapper through captured host descriptors before any
  property access. Required and optional accessors, unknown properties, inherited state, symbols, and Proxies reject
  without executing caller behavior or contacting either collaborator.
- A trusted-clock exception after a successful durable claim is now consumed into `terminal_ambiguity` using the last
  valid claimed time. It makes zero native bridge calls and cannot be retried.

No Hermes/native/SSH/provider/credential/protected-value/network/deployment effect occurred.

## Frozen implementation

- Product commit: `2bc80a20c7e4e1753b014395866972622c134fd3`.
- Rejected first remediation: `bb1faf989486bb3b16226d9a4cbec2223ef4e5f2`.
- First remediation re-review report SHA-256:
  `7f9e3f73142a3af120218f3df51f9e47fbc71d5764bb586346da7c87ee75bd62`.
- Findings remediated: `CR12B-RR001-001` and `CR12B-RR001-002`.
- Accepted second re-review report SHA-256:
  `6ed834e8b5c3418bc0bc932e56ae991a9c33f4699b81860f78be194a34a5b9c8`.
- Accepted report PR: #209; merge commit `710c6cba374d0a2e3e18b4636e376dba8d708441`.

## Verification

- exact gateway suite: 10/10;
- combined CR12B suite: 140/140;
- registered pretests: 769/769;
- core tests: 414/416 with zero failures and two intentional platform skips;
- registered posttests: 219/219;
- TypeScript, full lint, macOS stage zero, and whitespace validation: pass;
- production build and rendered routes: 3/3 pass; and
- database verification: 32 migrations and 110 PostgreSQL tables pass.

Producer verification did not accept this security boundary. The second different reviewer repeated all six recorded
attacks, found them closed, reported no new finding, and retained every later connector, signer, enrollment, preflight,
packet, authorization, and native-effect blocker. The connector block is open; enrollment remains forbidden.
