# Windows Job Object cancellation binding

The Windows package must run the bridge and every child executor in one Job Object with kill-on-close enabled. Its native wrapper is a later owner-tested implementation requirement, not a PowerShell fallback and not a static package side effect.

The static package explicitly refuses to claim this binding is active. Native acceptance must prove that a stop request closes the Job Object and no bridge-owned child remains. The wrapper may not attach unrelated pre-existing processes, run elevated by default, or inherit an administrator credential scope.
