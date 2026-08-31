import {
  parseAgentTeamDurabilityProjectionV1,
  parseAgentTeamWorkspaceV1,
  projectAgentTeamHandoffReviewV1,
  type AgentTeamDurabilityProjectionV1,
  type AgentTeamWorkspaceV1,
} from "@/src/agent-team/v1";

function label(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function shortTime(value: string | undefined): string {
  if (!value) return "No current observation";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "UTC" })
    .format(new Date(value)) + " UTC";
}

export function AgentTeamWorkspace({ fixture, durabilityFixture }: {
  fixture: AgentTeamWorkspaceV1;
  durabilityFixture: AgentTeamDurabilityProjectionV1;
}) {
  const view = parseAgentTeamWorkspaceV1(fixture);
  const durability = parseAgentTeamDurabilityProjectionV1(durabilityFixture);
  if (durability.tenantId !== view.tenantId || durability.workspaceId !== view.workspaceId || durability.projectId !== view.projectId) {
    throw new Error("Agent Team durability scope mismatch");
  }
  const names = new Map(view.agents.map((agent) => [agent.agentId, agent.displayName]));
  const durableRooms = new Map(durability.rooms.map((room) => [room.roomId, room]));
  const primaryRoom = view.rooms.find((room) => room.needsOwner) ?? view.rooms[0];

  return (
    <section className="agent-team-workspace" aria-labelledby="agent-team-title">
      <header className="agent-team-banner">
        <div>
          <p className="eyebrow">Project workspace · Agents</p>
          <h2 id="agent-team-title">Your agent team, in one room</h2>
          <p>See who is working, what routines are queued, and where a bounded conversation needs you—without turning chat into execution authority.</p>
        </div>
        <dl>
          <div><dt>Working now</dt><dd>{view.activeAgentCount}</dd></div>
          <div><dt>Needs you</dt><dd>{view.needsOwnerCount}</dd></div>
          <div><dt>War rooms</dt><dd>{view.rooms.length}</dd></div>
          <div><dt>Draft handoffs</dt><dd>{view.handoffProposals.length}</dd></div>
        </dl>
      </header>

      <p className="agent-team-safety" role="note"><strong>Authenticated local persistence.</strong> Presence is evidence-based, restart state is checked before use, and only safe summaries are retained. Every handoff below is still a draft—not a job, approval, lease, or dispatch.</p>

      <section className="agent-owner-inbox" aria-labelledby="agent-owner-inbox-title">
        <div className="agent-team-heading">
          <div><p className="eyebrow">Owner inbox</p><h3 id="agent-owner-inbox-title">Rooms waiting for you</h3></div>
          <span>{durability.unreadMessageCount} unread · {durability.savedDraftCount} saved drafts</span>
        </div>
        <div className="agent-durability-status" role="status">
          <span><b>Ledger</b> Authenticated locally</span>
          <span><b>Checkpoint</b> Matched</span>
          <span><b>Restart</b> Verify before use</span>
          <span><b>Retention</b> Preserve until configured</span>
        </div>
        <div className="agent-room-inbox-grid">
          {durability.rooms.map((room) => (
            <article key={room.roomId} className={room.needsOwner ? "needs-owner" : undefined}>
              <header><h4>{room.roomLabel}</h4>{room.needsOwner ? <em>Needs you</em> : <span>Up to date</span>}</header>
              <dl>
                <div><dt>Unread</dt><dd>{room.unreadCount}</dd></div>
                <div><dt>Direct needs</dt><dd>{room.unreadNeedsOwnerCount}</dd></div>
                <div><dt>Read through</dt><dd>{room.readThroughSequence}/{room.latestRoomSequence}</dd></div>
                <div><dt>Saved drafts</dt><dd>{room.savedDraftCount}</dd></div>
              </dl>
              <footer>{room.legalHoldState === "active" ? "Legal hold active" : "No legal hold"} · Safe summaries only</footer>
            </article>
          ))}
        </div>
      </section>

      <section className="agent-active-strip" aria-labelledby="active-team-title">
        <div className="agent-team-heading"><div><p className="eyebrow">Active now</p><h3 id="active-team-title">Team presence</h3></div><span>{view.agents.length} project members</span></div>
        <div className="agent-active-grid">
          {view.agents.map((agent) => (
            <article key={agent.agentId} className={`agent-presence-card status-${agent.status}`}>
              <header>
                <span className="agent-avatar" aria-hidden="true">{agent.displayName.slice(0, 2).toUpperCase()}</span>
                <div><h4>{agent.displayName}</h4><small>{agent.handle}</small></div>
                <b>{label(agent.status)}</b>
              </header>
              <p>{agent.role}</p>
              <dl>
                <div><dt>Presence</dt><dd>{label(agent.presenceBasis)}</dd></div>
                <div><dt>Route</dt><dd>{agent.deviceLabel} · {label(agent.platform)}</dd></div>
                <div><dt>Model class</dt><dd>{label(agent.modelClass)}</dd></div>
                <div><dt>Queue</dt><dd>{agent.queuedWorkCount} waiting</dd></div>
              </dl>
              {agent.currentWorkSummary ? <p className="agent-current-work"><strong>Now</strong>{agent.currentWorkSummary}</p> : null}
              <footer><span>{shortTime(agent.lastObservedAt)}</span>{agent.needsOwner ? <em>Needs you</em> : <span>{agent.reviewedPackageIds.length} reviewed packages</span>}</footer>
            </article>
          ))}
        </div>
      </section>

      <div className="agent-team-columns">
        <section className="agent-team-panel" aria-labelledby="routine-title">
          <div className="agent-team-heading"><div><p className="eyebrow">Automations</p><h3 id="routine-title">Agent routines</h3></div><span>Schedules are not permission</span></div>
          <div className="agent-routine-list">
            {view.routines.map((routine) => (
              <article key={routine.routineId} className={`routine-${routine.state}`}>
                <header><h4>{routine.label}</h4><b>{label(routine.state)}</b></header>
                <p>{routine.safeSummary}</p>
                <footer><span>{names.get(routine.agentId)}</span><span>{routine.nextOccurrenceAt ? shortTime(routine.nextOccurrenceAt) : label(routine.lastOutcomeCode ?? "not scheduled")}</span>{routine.needsOwner ? <em>Owner scope required</em> : null}</footer>
              </article>
            ))}
          </div>
        </section>

        <aside className="agent-team-panel agent-handoff-panel" aria-labelledby="handoff-title">
          <div className="agent-team-heading"><div><p className="eyebrow">Draft work</p><h3 id="handoff-title">Handoff proposals</h3></div><span>Review before materialization</span></div>
          {view.handoffProposals.map((proposal) => {
            const saved = durability.savedDrafts.find((draft) => draft.proposalId === proposal.proposalId
              && draft.proposalDigest === proposal.proposalDigest);
            const review = projectAgentTeamHandoffReviewV1({ tenantId: view.tenantId, projectId: view.projectId, proposal });
            return (
            <article key={proposal.proposalId}>
              <header><span>{saved ? "Saved locally · Awaiting owner" : "Draft only"}</span><b>{label(proposal.platform)}</b></header>
              <h4>{proposal.title}</h4>
              <p>{proposal.goal}</p>
              <dl>
                <div><dt>Proposed agent</dt><dd>{names.get(proposal.targetAgentId)}</dd></div>
                <div><dt>Route</dt><dd>{proposal.routeProfile}</dd></div>
                <div><dt>Action Inbox</dt><dd>{label(review.actionInbox.state)}</dd></div>
                <div><dt>Review state</dt><dd>{label(review.reviewState)}</dd></div>
                <div><dt>Dispatch</dt><dd>Not requested</dd></div>
                <div><dt>Work item</dt><dd>Not created</dd></div>
              </dl>
              <div className="agent-review-options" aria-label="Available owner decisions">
                {review.actionInbox.legalResponses.map((response) => <span key={response.id}>{response.label}</span>)}
              </div>
              <footer>Source room, message, exact draft digest, and owner decision are bound together. This local preview cannot record a decision or dispatch work.</footer>
            </article>
          )})}
        </aside>
      </div>

      {primaryRoom ? <section className="agent-war-room" aria-labelledby="war-room-title">
        <header className="agent-team-heading">
          <div><p className="eyebrow">Bounded collaboration</p><h3 id="war-room-title">{primaryRoom.label}</h3></div>
          <span className={`room-state state-${primaryRoom.state}`}>{durableRooms.get(primaryRoom.roomId)?.unreadCount ?? 0} unread · {label(primaryRoom.state)}</span>
        </header>
        <div className="war-room-layout">
          <div className="war-room-thread" aria-label={`${primaryRoom.label} safe message summaries`}>
            {primaryRoom.messages.map((message) => (
              <article key={message.messageId} className={`message-${message.authorKind}`}>
                <header><strong>{message.authorKind === "owner" ? "You" : message.authorKind === "system" ? "Control Room" : names.get(message.authorId)}</strong><span>Round {message.round} · {shortTime(message.occurredAt)}</span></header>
                <p>{message.safeSummary}</p>
                {(message.mentionedAgentIds.length > 0 || message.mentionsOwner) ? <footer>{[...message.mentionedAgentIds.map((id) => `@${names.get(id) ?? id}`), ...(message.mentionsOwner ? ["@you"] : [])].join(" · ")}</footer> : null}
              </article>
            ))}
          </div>
          <aside className="war-room-guardrails">
            <p className="eyebrow">Conversation ceiling</p>
            <dl>
              <div><dt>Members</dt><dd>{primaryRoom.memberAgentIds.length}/6</dd></div>
              <div><dt>Rounds</dt><dd>{primaryRoom.currentRound}/{primaryRoom.maxRounds}</dd></div>
              <div><dt>Messages</dt><dd>{primaryRoom.messages.length}/{primaryRoom.maxMessages}</dd></div>
              <div><dt>Duration</dt><dd>{primaryRoom.maxDurationSeconds / 60} minutes</dd></div>
              <div><dt>Reasoning ceiling</dt><dd>{primaryRoom.maxReasoningUnits.toLocaleString("en-US")}</dd></div>
              <div><dt>Cost ceiling</dt><dd>${primaryRoom.maxCostUsd}</dd></div>
            </dl>
            <p>Loops stop at the first reached ceiling. Full canonical audit remains required; this summary thread is never the job or evidence record.</p>
          </aside>
        </div>
      </section> : null}

      <footer className="agent-team-footer">Hermes-style team visibility, Control Room authority. No provider credentials are shared, no full messages are retained, and durable drafts cannot dispatch work.</footer>
    </section>
  );
}
