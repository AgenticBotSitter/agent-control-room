# Public welcome page — unpublished source

This separate static page is an information-only draft. It is not the Control Room
application or a public source release. The owner confirmed `agentcontrolroom.xyz`
as the welcome-page domain. The confirmed public project repository is
https://github.com/AgenticBotSitter/agent-control-room; source release remains pending.
Maintainer: Alastair Fraser. Main website: https://agenticbotsitter.com.
The owner confirmed the project contact as
Alastair@agenticbotsitter.com. No DNS or hosting configuration has been changed.

Only `index.html` and `styles.css` belong in a future welcome-page deployment. Do not
serve the repository root, `app/`, `private-app/`, `dist/server/`, local databases,
documentation drafts or this README as the website. No framework build or npm install
is needed for these two authored static files.

The page uses no scripts, cookies, browser storage, forms, external fonts, images,
analytics or remote embeds. There are no private application links. Its stylesheet
is a sibling file so the page is not dependent on the application build or credentials.

Before publication:

1. Verify DNS control for `agentcontrolroom.xyz` and current site content. Do not overwrite
   an existing website or infer that the domain is unused.
2. Confirm the public repository and contribution destinations. Replace the forthcoming
   notices with real links only when those resources are available.
3. Review copy, rights, maintainer credit and any contact/license additions.
4. Perform explicit browser, keyboard, narrow-screen and text-enlargement checks.
5. Approve the exact two-file candidate and deployment destination separately. Configure
   HTTPS and hosting response headers, including frame restrictions; the HTML policy
   does not replace hosting configuration. Keep the private application separate.

Local source checks: `node --test tests/public-welcome-source.test.mjs`.
Those checks verify authored content boundaries and local references, not rendering,
domain ownership, hosting security or interactive acceptance.
