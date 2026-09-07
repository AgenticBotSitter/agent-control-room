export function PrivateHeader() {
  return <header className="private-header"><a href="/projects" className="private-brand">Control Room</a>
    <span>Private workspace</span><nav aria-label="Workspace pages"><a href="/projects">Projects</a>
      <a href="/ideas">Idea Lab</a><a href="/connections">Connections</a><a href="/needs-me">Needs Me</a><a href="/session">Session and sign out</a></nav></header>;
}
