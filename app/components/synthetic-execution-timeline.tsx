import type { JSX } from "react";

export interface SyntheticExecutionTimelineEventV1 {
  sequence: number;
  occurredAt: string;
  event: "started" | "progress" | "checkpointed" | "waiting" | "completed" | "failed" | "cancelled";
  completedSteps?: number;
  totalSteps?: number;
  progressPercent?: number;
  checkpointId?: string;
  safeReasonCode?: string;
}

export interface SyntheticExecutionTimelineModelV1 {
  schema: "control-room.synthetic-execution-timeline/v1";
  jobId: string;
  attemptId: string;
  events: readonly SyntheticExecutionTimelineEventV1[];
}

const EVENT_LABELS: Record<SyntheticExecutionTimelineEventV1["event"], string> = {
  started: "Started",
  progress: "Progress",
  checkpointed: "Checkpoint",
  waiting: "Waiting",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

function eventDetails(event: SyntheticExecutionTimelineEventV1): string[] {
  const details: string[] = [];
  if (event.completedSteps !== undefined) details.push(`Completed steps: ${event.completedSteps}`);
  if (event.totalSteps !== undefined) details.push(`Total steps: ${event.totalSteps}`);
  if (event.progressPercent !== undefined) details.push(`Progress: ${event.progressPercent}%`);
  if (event.checkpointId !== undefined) details.push(`Checkpoint ID: ${event.checkpointId}`);
  if (event.safeReasonCode !== undefined) details.push(`Reason code: ${event.safeReasonCode}`);
  return details;
}

export function SyntheticExecutionTimeline(props: {
  model: SyntheticExecutionTimelineModelV1;
}): JSX.Element {
  const { model } = props;
  return (
    <section aria-labelledby="synthetic-execution-timeline-heading">
      <h3 id="synthetic-execution-timeline-heading">Synthetic execution timeline</h3>
      <p>
        Job: {model.jobId} · Attempt: {model.attemptId}
      </p>
      {model.events.length === 0 ? (
        <p role="status">No execution events recorded</p>
      ) : (
        <ol>
          {model.events.map((event) => (
            <li key={event.sequence}>
              <span>Sequence: {event.sequence}</span>{" "}
              <strong>{EVENT_LABELS[event.event]}</strong>{" "}
              <span>Occurred at: {event.occurredAt}</span>
              {eventDetails(event).length > 0 ? (
                <ul>
                  {eventDetails(event).map((detail) => (
                    <li key={detail}>{detail}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export default SyntheticExecutionTimeline;
