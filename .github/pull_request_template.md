## Completed outcome

Control-Room-Issue: NUMBER
Worker-Model: PROVIDER/MODEL
Worker-Effort: none|minimal|low|medium|high|xhigh|max|ultra|unknown
Worker-Active-Minutes: MINUTES_EXCLUDING_WAITING (optional, or unknown)
Worker-Started-At: ISO_8601_ACTIVE_WORK_START (optional, or unknown)
Worker-Ended-At: ISO_8601_ACTIVE_WORK_END (optional, or unknown)
Worker-Input-Tokens: COUNT (optional, exact provider-reported count or unknown)
Worker-Output-Tokens: COUNT (optional, exact provider-reported count or unknown)
Worker-Provider-Calls: COUNT (optional, exact count or unknown)
Worker-Interruptions: COUNT (optional, owner/limit/tool pauses, or unknown)

Starting commit / submitted commit:

Files changed and why:

Commands run and actual results:

What was not tested:

Upstream code, versions, licenses and attribution:

Known limitations or nonblocking follow-up:

Independent checker model, verdict and focused checks (automated workers):

## Evidence

<!--
Use one bullet per claim and at least one evidence line per bullet.
Test references must use the exact checked-in test name. CI references may use
the job ID or displayed job name. A cmd reference must include its actual output
in a fenced block. Delete the examples before submitting.
-->

- Focused behavior covered by a named test.
  test: tests/example.test.mjs::exact test name
- Existing CI job covering the broader change.
  ci: Quick checks
- Local verification command and output.
  cmd: node --test tests/example.test.mjs
  ```text
  paste actual output here
  ```
