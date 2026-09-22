import { readOperatorCapacityViewV1, type OperatorCapacityViewV1 } from "./operator-capacity-browser-client";
import { readTaskHomeActivity } from "./task-home-browser-client";
import { readTaskProjectAgentOptions } from "./task-project-agents-browser-client";
import { readTaskProjectAttention } from "./task-project-attention-browser-client";
import { readTaskProjectOverview } from "./task-project-overview-browser-client";
import type { TaskProjectAgentOptions } from "./task-project-agents-wire";

type Read<T> = Readonly<{ state: "ready"; value: T } | { state: "unavailable" }>;

export type ControlRoomWorkboardReadV1 = Readonly<{
  home: Read<Awaited<ReturnType<typeof readTaskHomeActivity>>>;
  capacity: Read<OperatorCapacityViewV1>;
  project?: Read<Awaited<ReturnType<typeof readTaskProjectOverview>>>;
  eligibility?: Read<TaskProjectAgentOptions>;
  inbox?: Read<Awaited<ReturnType<typeof readTaskProjectAttention>>>;
  reviews?: Read<Awaited<ReturnType<typeof readTaskProjectAttention>>>;
}>;

const observed = <T,>(read: Promise<T>): Promise<Read<T>> => read.then(
  value => ({ state: "ready", value }), () => ({ state: "unavailable" }),
);

/**
 * A compact, read-only composition of existing private projections. It does
 * not introduce a board API, controller, polling authority, or fallback data.
 */
export async function readControlRoomWorkboardV1(projectId?: string, transport: typeof fetch = fetch,
  signal?: AbortSignal): Promise<ControlRoomWorkboardReadV1> {
  const homeRead = observed(readTaskHomeActivity(transport, signal));
  const capacityRead = observed(readOperatorCapacityViewV1({ fetcher: transport, signal }).then(result => {
      if (result.state !== "available") throw new Error("capacity_unavailable");
      return result.view;
    }));
  if (!projectId) {
    const [home, capacity] = await Promise.all([homeRead, capacityRead]);
    return Object.freeze({ home, capacity });
  }
  // Begin every independent protected read together. Navigation cancellation
  // therefore reaches every in-flight GET, rather than leaving project reads
  // to begin after a slower global observation completes.
  const projectRead = observed(readTaskProjectOverview(projectId, transport, signal));
  const eligibilityRead = observed(readTaskProjectAgentOptions(projectId, transport, signal));
  const inboxRead = observed(readTaskProjectAttention(projectId, "inbox", undefined, transport, signal));
  const reviewsRead = observed(readTaskProjectAttention(projectId, "reviews", undefined, transport, signal));
  const [home, capacity, project, eligibility, inbox, reviews] = await Promise.all([
    homeRead, capacityRead, projectRead, eligibilityRead, inboxRead, reviewsRead,
  ]);
  return Object.freeze({ home, capacity, project, eligibility, inbox, reviews });
}
