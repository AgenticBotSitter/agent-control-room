# Initial asset and stylesheet review

2026-09-06. Local review; no image licensed, replaced or published.

## Findings

- The two tracked public assets are `public/favicon.svg` and
  `public/control-room-preview.png`. Both first appear in local commit `24556ea`.
  Git authorship establishes repository history, not sufficient license provenance.
  No matching asset attribution was found in the inspected public/third-party notices.
  Their redistribution rights remain unresolved; this is not a legal clearance.
- The PNG is used by the original README and preview layout metadata, not the protected
  application. Preserve it in the private checkout and existing preview; exclude it
  from the proposed standalone distribution unless a separate need and rights are established.
- The favicon is required by the current protected client-asset loader. Retain the
  existing icon for local builds; public distribution requires provenance confirmation
  or an approved replacement. Do not disable startup validation to work around it.
- No tracked WOFF/TTF/OTF files were found. Inspected shared/private CSS uses named
  system fallback fonts and a Tailwind import, with no `@font-face` or `url()` source.
  This does not review generated dependencies or every future asset.
- Shared CSS contains media-demo selectors and responsive rules. Do not mechanically
  delete matching lines: rules may share declarations, and the original demo still
  needs its styling. Extract generic styles with consumer/regression checks later;
  a filename or selector alone is not evidence of confidential data.

## Packaging correction implemented

Before this change, Vite copied the entire public directory into `dist-vps/client`,
including the preview PNG. The serving loader did not serve that PNG, but it still
existed in the built artifact and could be accidentally included in a later archive.

The standalone configuration now disables blanket public-directory copying and uses
a small standard Vite asset hook to emit only the required favicon for the client
environment. No new package, release framework or asset pipeline was introduced.
The preview configuration and original assets remain intact. Framework-generated
client assets remain produced normally.

The built-serving regression checks that the preview PNG is physically absent, the
favicon bytes match the local source, and the existing authenticated routes/assets
continue to work. Merely refusing an HTTP path is no longer the only check.

Verification: standalone build, all 52 combined compiled/profile/launcher checks,
TypeScript and targeted lint pass. Logs remain local under
`/private/tmp/cr-explicit-assets-build.log` and `/private/tmp/cr-explicit-assets-tests.log`.
No full default suite, visual browser review or hosted preview build was run.

## Remaining decisions

Confirm original-asset rights or approve replacement artwork before public export.
Audit the final generated client tree and dependency notices, not just source assets.
Maintain a public-safe README without inherited private-preview imagery. No asset
right is inferred from private use, commit authorship or a successful build.
