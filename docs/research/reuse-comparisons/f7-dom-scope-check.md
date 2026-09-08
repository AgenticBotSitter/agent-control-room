# Readability DOM scope and attribution check

Local comparison checkpoint `17bef80`; no adoption, application edit or new runtime
test in this root pass. Two retained actual-execution receipts use corpus SHA256
`4f7f0d52d377129144bcd2674c718f9ad5d8b77e1c165d7b804013e3cb172f6a`.

Root parsed the jsdom and bundled-parser receipts, asserted identical corpus hashes
and row IDs, and compared disposition/title, SHA256 of textContent/content and the
expectation result. All six rows agree; all returned strings are byte-identical on
this corpus. Empty/error/preparse rows have no strings and are not counted as
successful extraction. This is receipt comparison, not another extractor execution.

The result shows the40-package jsdom closure is not automatically required to use
Readability. It does not prove general DOM equivalence: explicit base tags, malformed
layouts, charset handling and varied real articles were not in this corpus. Both
variants retain the navigation-only false positive and event-handler output.

## File-level license distinction

The evaluator found an MPL-2.0 header in shipped `JSDOMParser.js`, distinct from
the root Apache license. Preserve this finding in any package/file inventory;
neither root metadata nor the lack of extra npm dependencies establishes an
Apache-only bundle. No source file has been copied into the application.

Mozilla's official FAQ permits combining MPL and Apache code and describes
file-level obligations. Thus this notice is not, by itself, a reason to reject
the candidate or relicense all Control Room code.
[Mozilla FAQ, Q11–Q13](https://www.mozilla.org/en-US/MPL/2.0/FAQ/).

If selected for redistribution, keep the covered file's notices and license,
identify any covered modifications, provide its source under MPL and explain how
recipients obtain that source when distributing an executable/minified form.
Other files in a larger work can retain their own terms, subject to the license's
conditions. Exact bundled/source distribution still needs release review; these
are planning constraints, not legal clearance of an unbuilt release.
[MPL2.0, sections1.10 and3.1–3.4](https://www.mozilla.org/en-US/MPL/2.0/).

Keep file boundaries/provenance visible and prefer unchanged upstream source over
a local parser fork. Evaluate technical supported-API/typing/update costs separately
from license labels; do not misrepresent a shipped subpath used by upstream tests
as the same stability guarantee as the package's primary documented API.
