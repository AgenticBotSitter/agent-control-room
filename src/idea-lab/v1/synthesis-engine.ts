import { buildIdeaLabSynthesisV1, parseIdeaLabContributionV1, parseIdeaLabSessionV1 } from "./contracts";
import { IdeaLabErrorV1 } from "./errors";
import type { IdeaLabContributionV1, IdeaLabSynthesisV1 } from "./types";

const mean = (values: number[]) => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : 50;
const excerpt = (text: string) => text.length <= 64 ? text : `${text.slice(0, 63)}…`;

/** Extracts final-turn text; does not call an LLM or claim semantic agreement.
 * Existing v1 score fields remain legacy confidence proxies, not business measurements. */
export class DeterministicIdeaLabSynthesisEngineV1 {
  build(session: unknown, values: IdeaLabContributionV1[], synthesizedAt: string): IdeaLabSynthesisV1 {
    const parsed = parseIdeaLabSessionV1(session);
    const contributions = values.map(value => parseIdeaLabContributionV1(value, parsed));
    const tuples = new Set(contributions.map(c => `${c.participantId}:${c.round}`));
    if (contributions.length !== parsed.maxMessages || tuples.size !== parsed.maxMessages
      || parsed.participants.some(p => Array.from({ length: parsed.maxRounds }, (_, i) => i + 1)
        .some(round => !tuples.has(`${p.participantId}:${round}`)))) throw new IdeaLabErrorV1("panel_incomplete");
    const latest = parsed.participants.map(p => contributions.find(c => c.participantId === p.participantId && c.round === parsed.maxRounds)!);
    const fallback = mean(latest.map(c => c.confidencePercent));
    const score = (names: string[]) => { const matches = latest.filter(c => names.includes(c.perspective));
      return matches.length ? mean(matches.map(c => c.confidencePercent)) : fallback; };
    const votes = new Map<string, number>();
    for (const c of latest) votes.set(c.suggestedExperiment, (votes.get(c.suggestedExperiment) ?? 0) + 1);
    // Exact-text repetition only. Stable participant ID breaks ties, not confidence.
    const next = [...latest].sort((a, b) => votes.get(b.suggestedExperiment)! - votes.get(a.suggestedExperiment)!
      || (a.participantId < b.participantId ? -1 : a.participantId > b.participantId ? 1 : 0))[0]!;
    const executiveSummary = "Extractive recap of final turns, not an AI consensus. Legacy score uses confidence, not measured demand or risk. Read full turns for context.\n"
      + latest.map(c => `${c.perspective}: “${excerpt(c.safeOpinion.replace(/\s+/g, " ").trim())}”`).join("\n");
    return buildIdeaLabSynthesisV1(parsed, contributions, {
      marketDemand: score(["customer", "market"]), feasibility: score(["operations", "technology"]),
      differentiation: score(["market", "growth"]), durability: Math.max(0, 100 - score(["skeptic", "risk"])),
      ownerFit: score(["customer", "operations"]), riskPercent: score(["skeptic", "risk"]),
      executiveSummary, nextExperiment: next.suggestedExperiment,
      dissentingPerspectiveCodes: [...new Set(latest.filter(c => ["skeptic", "risk"].includes(c.perspective)).map(c => c.primaryRiskCode))].sort(),
      synthesizedAt,
    });
  }
}
