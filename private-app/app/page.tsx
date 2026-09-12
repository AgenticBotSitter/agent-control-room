import { PrivateHeader } from "./private-header";
import { useProductDisplayName, useProductModule } from "./product-configuration";

const destinations = [
  { href: "/projects", title: "Projects", detail: "Open a project, create ordinary work, or continue with its saved tasks and reviews." },
  { href: "/workers", title: "Workers", detail: "Review the saved connection inventory and its last verified signals." },
  { href: "/needs-me", title: "Needs attention", detail: "Check owner-only task attention and recovery observations. Checking does not start work." },
  { href: "/settings", title: "Settings", detail: "Read the session and security boundaries for this private workspace." },
] as const;

export default function Home() {
  const displayName = useProductDisplayName();
  const ideaLab = useProductModule("ideaLab");
  return <div className="private-shell"><PrivateHeader /><main id="private-main">
    <section className="private-home-intro" aria-labelledby="home-title">
      <p className="private-eyebrow">Private workspace</p>
      <h1 id="home-title">{displayName}</h1>
      <p>Choose a saved workspace surface. This home page does not infer activity, worker availability, or review status before those records are loaded.</p>
    </section>
    <section aria-labelledby="home-navigation-title">
      <h2 id="home-navigation-title">Go to work</h2>
      <ul className="private-home-grid">
        {destinations.map(destination => <li key={destination.href}><a href={destination.href}>
          <h3>{destination.title}</h3><p>{destination.detail}</p><span>Open {destination.title}</span>
        </a></li>)}
      </ul>
    </section>
    {ideaLab && <aside className="private-note private-home-note" aria-label="Optional module">
      <strong>Idea Lab is optional.</strong> <a href="/ideas">Open Idea Lab</a> to work through a bounded discussion before promoting an approved idea to an ordinary project.
    </aside>}
  </main></div>;
}
