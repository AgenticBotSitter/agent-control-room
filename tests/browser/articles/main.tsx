import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { NewsArticleReader } from "../../../private-app/app/news-article-reader";
import { ResultText } from "../../../private-app/app/result-text";
import "../../../private-app/app/private.css";

// Synthetic UI fixture only. It cannot reach a real API or provider; unknown
// application fetches fail. This entry is not included in the production build.
let allowed = true;
const digest = `sha256:${"a".repeat(64)}`;
const text = "# Comparing agent tools\n\nThis disposable article demonstrates readable saved content. It is not a live source.\n\n## What to research\n\n- Installation requirements\n- Supported operating systems\n- Recovery after a disconnect\n\n| Tool | Status |\n| --- | --- |\n| Fixture A | Ready for review |\n| Fixture B | Needs research |\n\n```text\nThis is displayed text, never a command to execute.\n```\n\n![Remote image](https://example.invalid/never-fetch.png)\n\n<script>window.untrustedArticleRan=true</script>";
window.fetch = async input => {
  const url = new URL(String(input), window.location.origin);
  if (!url.pathname.endsWith("/news/article")) throw new Error("fixture_only");
  if (!allowed) return new Response("", { status: 401 });
  const projectId = decodeURIComponent(url.pathname.split("/")[4]);
  return Response.json({ tenantId: "tenant:fixture", workspaceId: "workspace:fixture", projectId,
    storyId: "story:fixture", storyDigest: digest, detailDigest: digest, sourceHash: digest,
    canonicalUrl: "https://example.invalid/article", status: "extracted",
    extractor: "@mozilla/readability@0.6.0+jsdom@26.1.0", text: `Project ${projectId}\n\n${text}` });
};
function App() {
  const [projectId, setProject] = useState("project:one");
  return <main className="private-main" id="private-main">
    <h1>Disposable article reader validation</h1><p>No live sources, agents or account data.</p>
    <div className="private-panel"><button onClick={() => setProject(value => value === "project:one" ? "project:two" : "project:one")}>Switch fixture project</button>
      <button onClick={() => { allowed = false; window.dispatchEvent(new Event("focus")); }}>Simulate expired access</button>
      <button onClick={() => { allowed = true; window.dispatchEvent(new Event("focus")); }}>Restore fixture access</button>
    </div>
    <article className="private-panel"><h2>{projectId} · Example saved news</h2><p>Source summary remains available when extraction is unavailable.</p>
      <NewsArticleReader key={projectId} projectId={projectId} storyId="story:fixture" storyDigest={digest} canonicalUrl="https://example.invalid/article" />
    </article>
    <section className="private-panel"><h2>Agent result renderer comparison</h2><ResultText text={text} /></section>
  </main>;
}
createRoot(document.getElementById("root")!).render(<App />);
