# Control Room observation adapter SDK (local candidate)

This source-only SDK accepts observation adapters. Its public shape has no operation, access, or authority method.

The SDK validates bounded ordinary data and rejects Proxy/accessor-backed boundary values. It invokes adapter functions in the caller's JavaScript process and is not a sandbox. Run only trusted adapter code here; isolate untrusted third-party code in a separate process with no credentials, private files, provider access, or network authority.
