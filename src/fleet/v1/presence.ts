export const FLEET_PRESENCE_TIMING_V1 = Object.freeze({
  checkInMs: 25_000,
  unreachableMs: 90_000,
});

export type FleetPresenceStateV1 = "online" | "checking_in" | "offline" | "unreachable";

/** Read projection only. It may show the 25-90 second hysteresis as
 * "checking in", but only the supervisor's durable transition may say that a
 * machine or bot is unreachable. */
export function projectFleetPresenceV1(input: Readonly<{ storedState: "online" | "offline" | "unreachable";
  lastSeenAt: string | Date; nowMs: number }>): FleetPresenceStateV1 {
  if (!Number.isSafeInteger(input.nowMs) || input.nowMs < 0) throw new Error("fleet_presence_clock_invalid");
  if (input.storedState !== "online") return input.storedState;
  const seen = Date.parse(new Date(input.lastSeenAt).toISOString());
  return input.nowMs - seen <= FLEET_PRESENCE_TIMING_V1.checkInMs ? "online" : "checking_in";
}
