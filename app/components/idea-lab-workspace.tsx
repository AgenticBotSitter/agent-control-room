import type { IdeaLabFixtureV1 } from "@/src/idea-lab/v1";
import { IdeaLabOperatorControls } from "./idea-lab-operator-controls";
import { IdeaLabConnectionReadiness } from "./idea-lab-connection-readiness";
import { LocalPilotOwnerSession } from "./local-pilot-owner-session";

function label(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function IdeaLabWorkspace({ fixture, operatorControlsEnabled = false }: { fixture: IdeaLabFixtureV1; operatorControlsEnabled?: boolean }) {
  const participant = new Map(fixture.session.participants.map((item) => [item.participantId, item]));
  return (
    <main className="detail-main idea-lab-page" id="idea-lab-content">
      <a className="skip-link" href="#idea-lab-panel">Skip to idea panel</a>
      {/* The node-only contract tests do not install Next's Link alias. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a className="detail-back" href="/">← Back to Control Room</a>

      <header className="idea-lab-hero">
        <div>
          <p className="eyebrow">Idea Lab · bounded multi-agent deliberation</p>
          <h1>Turn a rough business idea into a monitored project.</h1>
          <p>Several agents examine the same idea from deliberately different angles. Their advice is synthesized, but only the owner can create the project.</p>
        </div>
        <dl>
          <div><dt>Panel</dt><dd>{fixture.session.participants.length} lenses</dd></div>
          <div><dt>Score</dt><dd>{fixture.synthesis.overallScore}/100</dd></div>
          <div><dt>Recommendation</dt><dd>{label(fixture.synthesis.recommendation)}</dd></div>
          <div><dt>Owner decision</dt><dd>{label(fixture.decision.decision)}</dd></div>
        </dl>
      </header>

      <p className="idea-lab-boundary" role="status">{operatorControlsEnabled
        ? "Local pilot: protected writes use durable local PGlite and the repository-fake panel. No Hermes, Codex, local-model provider, production database, or public network is connected. The examples below remain labelled fixtures."
        : "Development fixture only: these are injected, safe summaries. No Hermes, Codex, or local-model provider was contacted, and this screen cannot dispatch work or create a live project."}</p>

      {operatorControlsEnabled?<LocalPilotOwnerSession/>:null}
      <IdeaLabOperatorControls enabled={operatorControlsEnabled} />
      <IdeaLabConnectionReadiness />

      <section className="idea-lab-panel" id="idea-lab-panel" aria-labelledby="idea-lab-title">
        <div className="section-heading"><div><p className="eyebrow">Current session</p><h2 id="idea-lab-title">{fixture.session.title}</h2></div><span className="simulation-only">Owner-controlled</span></div>
        <p className="idea-lab-summary">{fixture.session.ideaSummary}</p>
        <div className="idea-lab-context">
          <article><small>Target customer</small><p>{fixture.session.targetCustomer}</p></article>
          <article><small>Panel limits</small><p>{fixture.session.maxRounds} rounds · {fixture.session.maxMessages} messages · ${fixture.session.maxCostUsd.toFixed(2)} ceiling</p></article>
        </div>

        <div className="idea-lab-agent-grid" aria-label="Panel members">
          {fixture.session.participants.map((agent) => <article key={agent.participantId}>
            <span>{agent.displayName.slice(0, 2).toUpperCase()}</span>
            <div><h3>{agent.displayName}</h3><p>{label(agent.perspective)} perspective</p><small>{label(agent.harness)} · {agent.platform} · injected only</small></div>
          </article>)}
        </div>
      </section>

      <section className="idea-lab-panel" aria-labelledby="idea-lab-opinions">
        <div className="section-heading"><div><p className="eyebrow">Independent first pass</p><h2 id="idea-lab-opinions">What each lens found</h2></div></div>
        <div className="idea-lab-opinion-grid">
          {fixture.contributions.map((item) => <article key={item.contributionId}>
            <header><span>{label(item.perspective)}</span><b>{item.confidencePercent}% confidence</b></header>
            <h3>{participant.get(item.participantId)?.displayName}</h3>
            <p>{item.safeOpinion}</p>
            <footer><strong>Test next</strong>{item.suggestedExperiment}</footer>
          </article>)}
        </div>
      </section>

      <section className="idea-lab-synthesis" aria-labelledby="idea-lab-synthesis">
        <div className="idea-score"><strong>{fixture.synthesis.overallScore}</strong><span>Advisory score</span><small>{label(fixture.synthesis.recommendation)}</small></div>
        <div>
          <p className="eyebrow">Panel synthesis</p>
          <h2 id="idea-lab-synthesis">A promising idea with hard safety boundaries.</h2>
          <p>{fixture.synthesis.executiveSummary}</p>
          <dl>
            <div><dt>Demand</dt><dd>{fixture.synthesis.marketDemand}</dd></div>
            <div><dt>Feasibility</dt><dd>{fixture.synthesis.feasibility}</dd></div>
            <div><dt>Difference</dt><dd>{fixture.synthesis.differentiation}</dd></div>
            <div><dt>Risk</dt><dd>{fixture.synthesis.riskPercent}</dd></div>
          </dl>
          <p className="idea-next-step"><strong>Next experiment:</strong> {fixture.synthesis.nextExperiment}</p>
        </div>
      </section>

      <section className="idea-lab-promotion" aria-labelledby="idea-lab-promotion">
        <div><p className="eyebrow">Explicit owner promotion</p><h2 id="idea-lab-promotion">The idea now has a standard project home.</h2><p>The recorded owner decision created lifecycle version 1. It can be paused, completed, archived, or reopened without erasing its history.</p></div>
        <article><small>{fixture.promotedProject.workspaceName}</small><h3>{fixture.promotedProject.title}</h3><p>{fixture.promotedProject.summary}</p><footer><span>{label(fixture.promotedProject.lifecycleState)}</span><a href={fixture.promotedProject.monitoringPagePath}>Open project page →</a></footer></article>
      </section>
    </main>
  );
}
