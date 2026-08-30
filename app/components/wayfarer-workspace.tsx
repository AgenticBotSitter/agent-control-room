import type { WayfarerWorkspaceViewV1 } from "@/src/project-adapters/wayfarer/v1";

function label(value: string) { return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase()); }
function bytes(value: number) {
  if (value >= 1_073_741_824) return `${Math.round((value / 1_073_741_824) * 10) / 10} GiB`;
  if (value >= 1_048_576) return `${Math.round((value / 1_048_576) * 10) / 10} MiB`;
  return `${value} bytes`;
}

export function WayfarerWorkspace({ fixture }: { fixture: WayfarerWorkspaceViewV1 }) {
  const blockedScenarios = fixture.schedulingScenarios.filter((scenario) => !scenario.selectedForSimulation).length;
  return (
    <section className="wayfarer-workspace section-block" aria-label="Lo-Fi Wayfarer synthetic media workspace">
      <nav className="project-workspace-nav" aria-label="Wayfarer project workspace navigation">
        {fixture.workspace.sections.map((section, index) => (
          <span key={section.sectionId} className={index === 0 ? "current" : "planned"} aria-current={index === 0 ? "page" : undefined}>
            {section.label}{section.itemCount !== undefined ? <small>{section.itemCount}</small> : null}
          </span>
        ))}
      </nav>

      <header className="wayfarer-banner">
        <div>
          <p className="eyebrow">Episode control surface · No-byte synthetic evidence</p>
          <h2>{fixture.episode.title}</h2>
          <p>All six workflow stages produced deterministic metadata. None has authoritative completion yet, and no media, storage service, GPU, native tool, upload, or publication action ran.</p>
        </div>
        <dl>
          <div><dt>Synthetic stages</dt><dd>{fixture.episode.completedSyntheticStages}/6</dd></div>
          <div><dt>Accepted stages</dt><dd>{fixture.episode.authoritativeCompletedStages}/6</dd></div>
          <div><dt>Open reviews</dt><dd>{fixture.reviews.length}</dd></div>
          <div><dt>Blocked scenarios</dt><dd>{blockedScenarios}</dd></div>
        </dl>
      </header>

      <p className="wayfarer-safety-note" role="status"><strong>Unreal remains blocked.</strong> Declared synthetic resources and fake benchmark metadata cannot qualify a real render. A separately owner-controlled measured benchmark is still required.</p>

      <section className="wayfarer-panel wayfarer-benchmark-panel" aria-labelledby="wayfarer-benchmark-heading">
        <div className="wayfarer-heading"><div><p className="eyebrow">Native benchmark gate</p><h2 id="wayfarer-benchmark-heading">Unreal scene/render readiness</h2></div><span className="benchmark-disabled">Disabled · no attempt</span></div>
        <div className="wayfarer-benchmark-summary">
          <div><strong>{fixture.unrealBenchmark.metGateCount}/{fixture.unrealBenchmark.totalGateCount}</strong><span>prerequisites evidenced</span></div>
          <dl><div><dt>Maximum attempts</dt><dd>{fixture.unrealBenchmark.maximumAttempts}</dd></div><div><dt>Runtime ceiling</dt><dd>{fixture.unrealBenchmark.maximumRuntimeSeconds / 60} minutes</dd></div><div><dt>Provider cost</dt><dd>$0</dd></div><div><dt>Network</dt><dd>{label(fixture.unrealBenchmark.networkPolicy)}</dd></div></dl>
        </div>
        <div className="wayfarer-benchmark-gates" aria-label="Missing Unreal benchmark prerequisites">
          {fixture.unrealBenchmark.blockingGateIds.map((gateId) => <span key={gateId}>{label(gateId)}</span>)}
        </div>
        <p>Only the digest-bound benchmark packet exists. No private scene was read, no Unreal tool or native executor was qualified, no GPU work ran, and no render output was observed. Satisfying every gate would create only a candidate for a fresh owner-attended approval window.</p>
      </section>

      <section className="wayfarer-panel wayfarer-executor-panel" aria-labelledby="wayfarer-executor-heading">
        <div className="wayfarer-heading"><div><p className="eyebrow">Frozen native boundary</p><h2 id="wayfarer-executor-heading">Unreal executor</h2></div><span className="benchmark-disabled">Disabled before start</span></div>
        <div className="wayfarer-executor-summary">
          <dl><div><dt>Command model</dt><dd>None</dd></div><div><dt>Native adapter</dt><dd>Absent</dd></div><div><dt>Processes started</dt><dd>0</dd></div><div><dt>Scene reads</dt><dd>0</dd></div><div><dt>GPU work</dt><dd>0</dd></div><div><dt>Outputs observed</dt><dd>0</dd></div></dl>
          <p>The executor can evaluate the frozen packet and record a safe refusal. It has no process launcher, filesystem reader, private-locator resolver, credential resolver, network client, or artifact writer.</p>
        </div>
        <div className="wayfarer-benchmark-gates" aria-label="Disabled Unreal executor blockers">
          {fixture.unrealExecutor.executorBlockers.map((blocker) => <span key={blocker}>{label(blocker)}</span>)}
        </div>
      </section>

      <section className="wayfarer-panel wayfarer-delivery-panel" aria-labelledby="wayfarer-delivery-heading">
        <div className="wayfarer-heading"><div><p className="eyebrow">Delivery preparation</p><h2 id="wayfarer-delivery-heading">Upload and publication boundaries</h2></div><span className="benchmark-disabled">Prepared · disabled</span></div>
        <div className="wayfarer-delivery-summary">
          <div><strong>{fixture.deliveryPreparation.boundaryCount}</strong><span>separate protected boundaries</span></div>
          <dl><div><dt>Artifact declarations</dt><dd>{fixture.deliveryPreparation.artifactDeclarationCount}</dd></div><div><dt>Observed bytes</dt><dd>0</dd></div><div><dt>Destinations</dt><dd>0</dd></div><div><dt>Credentials</dt><dd>0</dd></div></dl>
        </div>
        <div className="wayfarer-delivery-grid">
          {fixture.deliveryPreparation.boundaries.map((boundary) => (
            <article key={boundary.boundaryId}>
              <header><span>Disabled · {boundary.metGateCount}/{boundary.totalGateCount}</span><small>High risk</small></header>
              <h3>{boundary.label}</h3>
              <dl><div><dt>Readiness gates</dt><dd>{boundary.metGateCount}/{boundary.totalGateCount}</dd></div><div><dt>Missing gates</dt><dd>{boundary.blockingGateIds.length}</dd></div><div><dt>Delivery attempts</dt><dd>0</dd></div><div><dt>Owner window</dt><dd>Not eligible</dd></div><div><dt>Exact destination</dt><dd>Missing</dd></div><div><dt>Destination idempotency</dt><dd>Required</dd></div><div><dt>Pre-effect marker</dt><dd>Required</dd></div><div><dt>Unknown after marker</dt><dd>Terminal ambiguity</dd></div></dl>
            </article>
          ))}
        </div>
        <div className="wayfarer-benchmark-gates" aria-label="Missing upload and publication requirements">
          {fixture.deliveryPreparation.blockingRequirements.map((blocker) => <span key={blocker}>{label(blocker)}</span>)}
        </div>
        <p>No destination, path, credential reference, media byte, adapter, job, approval, or effect claim exists. A future upload and a future publication must each receive a fresh exact package, strong owner approval, node authority, stable destination idempotency, and separate receipts.</p>
      </section>

      <section className="wayfarer-panel" aria-labelledby="wayfarer-pipeline-heading">
        <div className="wayfarer-heading"><div><p className="eyebrow">Media graph</p><h2 id="wayfarer-pipeline-heading">Six-stage production pipeline</h2></div><span>Evidence only · no jobs dispatched</span></div>
        <ol className="wayfarer-stage-grid">
          {fixture.stages.map((stage) => (
            <li key={stage.stageId}>
              <div><span>{stage.position + 1}</span><small>{label(stage.gpu)} GPU</small></div>
              <h3>{stage.label}</h3>
              <p>{stage.outputArtifactRoles.map(label).join(" · ")}</p>
              <dl><div><dt>Synthetic evidence</dt><dd>Ready</dd></div><div><dt>Completion</dt><dd>Not resolved</dd></div><div><dt>Independent reviews</dt><dd>0/{stage.minimumIndependentReviews}</dd></div><div><dt>Scratch floor</dt><dd>{bytes(stage.minimumScratchBytes)}</dd></div></dl>
            </li>
          ))}
        </ol>
      </section>

      <div className="wayfarer-columns">
        <section className="wayfarer-panel" aria-labelledby="wayfarer-artifacts-heading">
          <div className="wayfarer-heading"><div><p className="eyebrow">Files and artifacts</p><h2 id="wayfarer-artifacts-heading">Immutable artifact declarations</h2></div><span>0 observed bytes</span></div>
          <div className="wayfarer-artifact-list">
            {fixture.artifacts.map((artifact) => (
              <article key={artifact.artifactId} className={`artifact-${artifact.state}`}>
                <div><strong>{artifact.label}</strong><small>{artifact.contentType}</small></div>
                <span>{label(artifact.state)}</span>
                <dl><div><dt>Maximum</dt><dd>{bytes(artifact.declaredMaximumBytes)}</dd></div><div><dt>Material</dt><dd>Unavailable</dd></div><div><dt>Locator</dt><dd>Private / absent</dd></div></dl>
              </article>
            ))}
          </div>
        </section>

        <section className="wayfarer-panel" aria-labelledby="wayfarer-reviews-heading">
          <div className="wayfarer-heading"><div><p className="eyebrow">Completion Gate</p><h2 id="wayfarer-reviews-heading">Independent review queue</h2></div><span>No approval controls</span></div>
          <div className="wayfarer-review-list">
            {fixture.reviews.map((review) => (
              <article key={review.reviewId}>
                <div><span className={`review-risk risk-${review.risk}`}>{label(review.risk)}</span><small>{label(review.state)}</small></div>
                <h3>{review.subjectLabel}</h3>
                <p>{review.acceptedIndependentReviews}/{review.requiredIndependentReviews} independent reviews accepted</p>
                <footer>Review evidence is missing · Synthetic QC cannot complete this stage</footer>
              </article>
            ))}
          </div>
        </section>
      </div>

      <section className="wayfarer-panel" aria-labelledby="wayfarer-storage-heading">
        <div className="wayfarer-heading"><div><p className="eyebrow">Storage rehearsal</p><h2 id="wayfarer-storage-heading">Private stores · fake metadata only</h2></div><span>No paths, buckets, credentials, locators, or bytes</span></div>
        <div className="wayfarer-store-grid">
          {fixture.stores.map((store) => (
            <article key={store.storeId} className={store.state === "quarantine_present" ? "store-quarantine" : ""}>
              <div><h3>{store.label}</h3><span>{label(store.state)}</span></div>
              <dl><div><dt>Accounted objects</dt><dd>{store.accountedObjectCount}</dd></div><div><dt>Declared bytes</dt><dd>{bytes(store.accountedBytes)}</dd></div><div><dt>Live adapter</dt><dd>Not configured</dd></div></dl>
              <p>{store.state === "quarantine_present" ? "One injected integrity mismatch is quarantined. It cannot retry or complete." : "One exact metadata match was recorded. It does not prove that an object exists."}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="wayfarer-panel" aria-labelledby="wayfarer-scheduling-heading">
        <div className="wayfarer-heading"><div><p className="eyebrow">Fleet planning</p><h2 id="wayfarer-scheduling-heading">GPU and scratch simulations</h2></div><span>Selection only · no reservation</span></div>
        <div className="wayfarer-scenario-grid">
          {fixture.schedulingScenarios.map((scenario) => (
            <article key={scenario.scenarioId} className={scenario.selectedForSimulation ? "scenario-ready" : "scenario-blocked"}>
              <header><span>{scenario.selectedForSimulation ? "Synthetic route selected" : "Blocked safely"}</span><small>{label(scenario.platform)}</small></header>
              <h3>{scenario.label}</h3>
              <dl><div><dt>Scratch</dt><dd>{bytes(scenario.availableScratchBytes)} / {bytes(scenario.minimumScratchBytes)}</dd></div><div><dt>GPU</dt><dd>{scenario.availableGpuUnits} available · {scenario.requestedGpuUnits} requested</dd></div><div><dt>Benchmark</dt><dd>{label(scenario.benchmarkState)}</dd></div></dl>
              <p>{scenario.rejectionReasons.length ? scenario.rejectionReasons.map(label).join(" · ") : "All synthetic declaration gates passed."}</p>
              {scenario.reliefWouldMakeFeasible ? <footer>Releasing one declared unit would make the waiting item feasible. This is a projection, not a release instruction.</footer> : null}
            </article>
          ))}
        </div>
      </section>

      <p className="wayfarer-footer-note">This workspace is presentation-only. It creates no job, reservation, lease, dispatch, approval, storage operation, native execution, upload, or publication authority.</p>
    </section>
  );
}
