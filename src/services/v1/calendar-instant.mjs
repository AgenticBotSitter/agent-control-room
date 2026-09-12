import { DateTime } from "luxon";

/** Select the earlier UTC instant for an ambiguous local wall time.
 * @param {number} instant
 * @param {string} timezone
 * @returns {boolean}
 */
export function isFirstLocalInstant(instant, timezone) {
  const local = DateTime.fromMillis(instant, { zone: timezone });
  if (!local.isValid) return false;
  const candidates = local.getPossibleOffsets().map(value => value.toMillis());
  return candidates.length > 0 && candidates.every(Number.isFinite)
    && instant === Math.min(...candidates);
}
