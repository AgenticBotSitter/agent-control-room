import assert from "node:assert/strict";
import { test } from "node:test";
import { now, origin, token } from "./helpers/web-foundation";
import { prepared } from "./owner-bootstrap-ceremony-helper";

test("wrong assertion, cross-origin, wrong and expired codes never create an owner", async t => {
  // Four databases are isolated in this process; no additional fixture is created here.
  for (const kind of ["wrong-code", "wrong-assertion", "cross-origin", "expired"] as const) {
    const x = await prepared(); t.after(() => x.raw.close()); await x.ceremony.arm(x.attempt());
    if (kind === "expired") x.setClock(now + 5 * 60_000);
    const request = kind === "wrong-code" ? x.browser("A".repeat(43))
      : kind === "wrong-assertion" ? x.browser(x.code(), token({ aud: ["wrong"] }))
      : kind === "cross-origin" ? new Request(`${origin}/api/v1/owner-bootstrap`, { method: "POST",
        headers: { origin: "https://wrong.invalid", "content-type": "application/json", "cf-access-jwt-assertion": token() },
        body: JSON.stringify({ code: x.code() }) }) : x.browser();
    assert.equal((await x.ceremony.route(request))?.status, 503);
    assert.equal((await x.base.query<{ count: string }>("SELECT count(*)::text AS count FROM control_identities")).rows[0]?.count, "0");
  }
});
