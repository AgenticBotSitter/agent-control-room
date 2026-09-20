# Local Hermes worker on macOS

This document describes the **single-computer** Control Room option: a person
can use Control Room and Hermes Agent on the same Mac without treating Hermes
as a remote machine. It is the same Control Room product and uses the same
project, task, result, review, correction, and approval records as a
multi-computer installation.

## What is connected now

`createHermesMacosLocalSessionPortV1` connects the already-reviewed Hermes
session adapter to one Mac-owned private port. It allows only the three Hermes
session operations Control Room already supports:

- start one task turn;
- read that turn's status;
- read its bounded result.

The adapter passes only a stable local service label such as
`service:marvin-hermes`. It does not contain a hostname, filesystem path,
login, token, model name, shell command, or process-control instruction.
Those private details remain with the Mac integration owned by the operator.

The result still follows the normal Control Room result-publication and owner
review path. A local Hermes result is not automatically accepted just because
it came from the same computer.

## What is deliberately not claimed yet

The source adapter has unit tests, but it has not contacted a live Hermes
installation. A real qualification must separately verify the exact local
Hermes version and its supported session interface. If the first start call
loses its reply, Control Room must mark that task uncertain; it must not retry
and risk starting duplicate work.

No local listener, background service, credential access, or configuration
change is created by this code.

## Next activation step

An owner-attended Mac qualification supplies the private port and performs one
bounded read-only check before any real task is sent. Once that evidence is
accepted, the normal task dispatcher can use this local port for the same
worker lifecycle used by remote Hermes workers.
