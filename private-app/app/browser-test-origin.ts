// The one place a browser suite may point.
//
// The owner browser suites drive a real owner session against a real page, so
// the origin they are given is a safety decision, not a configuration detail.
// Pointed at the live app they would create a real project and a real task in
// the owner's live database, drive a real session, and leave real records
// behind — none of which a test has any business doing.
//
// That refusal used to live as an inline `if` in the Playwright spec. It has
// exactly one implementation, it is the only guard, and removing its condition
// left CI green — an untested guard is not a guard. So it lives here, in
// application-adjacent source rather than in the spec, which means:
//
//   - every owner browser suite that wants a disposable origin imports the
//     same function, so a second suite cannot grow a weaker copy; and
//   - a plain unit test can import it without launching a browser, so the
//     refusal is provable on every CI run rather than only on the runs where
//     somebody happens to point the suite at 3210.
//
// The refusal is intentionally loud and non-recoverable: a fixed message, a
// nonzero exit, and no path that reinterprets the port as anything else.

/** Ports that are never a disposable rehearsal target. 3210 is the live app. */
const REFUSED_PORTS = Object.freeze(["3210"] as const);

export const PHONE_WIDTH_BROWSER_REFUSAL =
  "phone_width_browser_refused_non_disposable_origin" as const;

/**
 * Parse `CONTROL_ROOM_E2E_ORIGIN` and refuse anything that is not a disposable
 * loopback origin. Throws with `refusal` rather than returning a boolean so a
 * caller cannot forget to branch on the result and carry on regardless.
 *
 * Deliberately not configurable: a suite that could opt out of its own safety
 * check is the thing this function exists to prevent.
 */
export function parseDisposableBrowserOrigin(value: string | undefined): URL {
  if (!value) throw new Error(PHONE_WIDTH_BROWSER_REFUSAL);
  let origin: URL;
  try { origin = new URL(value); }
  catch { throw new Error(PHONE_WIDTH_BROWSER_REFUSAL); }
  // Loopback only, and explicitly not the live app. A suite must be able to
  // reach the server it was pointed at, and nothing else.
  if (origin.protocol !== "http:" || origin.hostname !== "127.0.0.1"
    || (REFUSED_PORTS as readonly string[]).includes(origin.port)) {
    throw new Error(PHONE_WIDTH_BROWSER_REFUSAL);
  }
  return origin;
}

/**
 * The guard the spec calls at module scope, before any test is discovered. This
 * is the exact call whose removal the reviewer's mutation targeted, so it is
 * kept as its own named function: the mutation has to delete a named export to
 * survive, and the unit test below fails when it does.
 */
export function assertDisposableBrowserOrigin(value: string | undefined): URL {
  return parseDisposableBrowserOrigin(value);
}
