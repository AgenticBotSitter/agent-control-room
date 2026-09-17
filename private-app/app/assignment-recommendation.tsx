"use client";
import { recommendationScopeMatchesV1, type AssignmentRecommendationProjectionV1, type AssignmentRecommendationScopeV1 } from "../../src/assignment-recommendation/v1";

/**
 * Read-only presentation of the pre-assignment recommendation for one task.
 *
 * The panel renders the exact basis it was given and never invents the missing half: an
 * unknown effort, an unknown price or an unreadable capacity stays visibly unknown. The only
 * control it owns is "prefer this machine", which moves the caller's existing machine choice
 * and nothing else — the assignment command still goes through the protected check.
 */
export function AssignmentRecommendationPanel({ recommendation, scope, onPrefer }: {
  recommendation?: AssignmentRecommendationProjectionV1;
  scope: AssignmentRecommendationScopeV1;
  onPrefer?: (nodeId: string) => void;
}) {
  if (!recommendation) return null;
  if (!recommendationScopeMatchesV1(recommendation, scope)) return <section id="task-assignment-recommendation"
    className="private-panel" aria-label="Assignment recommendation"><h2>Assignment recommendation</h2>
    <p role="alert">A recommendation for a different project, task or draft was withheld. Nothing is reserved and no work is started.</p></section>;
  const chosen = recommendation.recommendation;
  const others = recommendation.alternatives.filter(candidate => candidate.nodeId !== chosen?.nodeId);
  return <section id="task-assignment-recommendation" className="private-panel" aria-label="Assignment recommendation">
    <h2>Assignment recommendation</h2>
    <p>{recommendation.explanation}</p>
    {chosen && <div>
      <p role="status">Recommended machine: {chosen.label} · {chosen.platform}. Harness or model class: {chosen.harness}. Recommended effort: {chosen.effort}.</p>
      <p>Capability basis: {chosen.capabilityProbeId}; {chosen.capacity.activeTaskCount} of {chosen.capacity.maxConcurrentTasks} slot(s) in use.</p>
      <p>{chosen.costTradeoff.cost === "reported_historical"
        ? `Reported historical duration median: ${chosen.costTradeoff.reportedMinutesMedian} minutes across ${chosen.costTradeoff.sampleSize} reported outcome(s).`
        : "Cost is unknown: no reported duration covers this capability."} {chosen.costTradeoff.usage === "reported_historical"
        ? `Reported historical usage median: ${chosen.costTradeoff.reportedTokensMedian} tokens.`
        : "Usage is unknown: no reported token count covers this capability."}</p>
      <p>Decision basis: {chosen.basis.join(", ")}.</p>
    </div>}
    {recommendation.limits.length > 0 && <p role="status">Limited: {recommendation.limits.join(", ")}. Unknown evidence stays unknown here.</p>}
    {others.length > 0 && <div><p>Other configured machines:</p>
      <ul>{others.map(candidate => <li key={candidate.nodeId}>{candidate.label} · {candidate.platform} · {candidate.eligible === null
        ? "eligibility not readable here" : candidate.eligible
        ? "eligible for this task" : "not currently eligible"}{onPrefer && candidate.eligible
        ? <button type="button" onClick={() => onPrefer(candidate.nodeId)}>Prefer this machine</button> : null}</li>)}</ul>
      <p>Preferring a machine only changes which machine the assignment command will ask for. It reserves nothing and starts no agent.</p></div>}
    <p>This recommendation is advice. It assigns no work, reserves no capacity and grants no execution authority.</p>
  </section>;
}