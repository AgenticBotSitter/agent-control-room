import { SessionControls } from "./session-controls";
export const dynamic = "force-dynamic";
export default function SessionPage() { return <main id="private-main" className="private-shell"><section className="private-panel">
  <h1>Your Control Room session</h1><p>Sign out here even if your project access has changed.</p><SessionControls />
  <p><a href="/projects">Back to projects</a></p></section></main>; }
