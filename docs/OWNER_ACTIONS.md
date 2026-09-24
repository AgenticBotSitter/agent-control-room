# Owner actions

Only steps the bots cannot do. Each item is numbered and copy-paste ready.

1. **Optional but required before final local release:** authorize the Claude Code
   reviewer to receive the small, sanitized Mac-local website source diff. The
   review checks that the local sign-in route cannot weaken the existing hosted
   website authentication. No credentials, protected configuration, database
   values, or private machine details are included. Until this authorization is
   available, Codex can continue building and testing but cannot record the
   plan-required external Claude verdict for this package.

2. **Optional parallel source inventory:** authorize the local Hermes helper to
   receive a bounded, sanitized W3 configuration-loader inventory prompt. It
   would be read-only, would not start services or read credentials, and would
   return only candidate source-file names and a recommended integration seam.
   This environment cannot send repository source to Hermes's selected model
   provider without separate authorization. Codex can continue the W3 build
   without this parallel report.
