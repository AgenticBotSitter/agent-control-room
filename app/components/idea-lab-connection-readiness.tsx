import {
  ideaLabHermes021BuiltInConnectionSourceV1,
  ideaLabHermes021ConnectionReassessmentV1,
} from "@/src/idea-lab/v1";

function words(value: string): string {
  return value.replaceAll("_", " ");
}

export function IdeaLabConnectionReadiness() {
  const source = ideaLabHermes021BuiltInConnectionSourceV1;
  const readiness = ideaLabHermes021ConnectionReassessmentV1;
  return (
    <section className="idea-lab-panel idea-connection-panel" aria-labelledby="idea-connection-title">
      <div className="section-heading">
        <div><p className="eyebrow">Hermes fleet connection</p><h2 id="idea-connection-title">Connect agents without changing Hermes</h2></div>
        <span className="simulation-only">Live access remains off</span>
      </div>
      <p className="idea-lab-summary">Control Room will use an owner-enrolled local or SSH tunnel to each machine. Hermes keeps its login, memory, and private files on that machine.</p>
      <div className="idea-connection-grid">
        <article><small>Hermes modification</small><strong>{source.hermesModificationRequired ? "Required" : "Not required"}</strong><p>The installed runtime supports fresh no-skills profiles with read-only access to its existing credential pool.</p></article>
        <article><small>Remote transport</small><strong>{source.capabilities.sshConnectionRegistry ? "SSH supported" : "Unavailable"}</strong><p>Only a pre-enrolled gateway route is exposed. Control Room receives no hostname, key path, session token, or generic shell.</p></article>
        <article><small>Current gate</small><strong>Waiting for enrollment</strong><p>{readiness.blockerCodes.map(words).join(" · ")}</p></article>
      </div>
      <p className="idea-connection-footnote">Source reviewed at Hermes revision {source.runtimeRevision.slice(0, 12)}. No SSH connection, Hermes session, provider call, or native qualification was started by this build.</p>
    </section>
  );
}
