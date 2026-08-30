# Control Room conformance kit (local candidate)

This source-only kit evaluates supplied synthetic fixtures against the observation adapter SDK. It does not discover, launch, or contact a harness.

The kit invokes the supplied adapter's functions in the caller's JavaScript process. It validates contract output but cannot prove that arbitrary adapter code is effect-free. Treat untrusted adapters as executable code and run them only inside a separately isolated environment.
