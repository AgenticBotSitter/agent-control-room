import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PrivateIdeaWorkspace } from "../private-app/app/idea-workspace";
import { PrivateNewsWorkspace } from "../private-app/app/news-workspace";

test("Idea list/detail and project news shells each provide exactly one main skip target", () => {
  const pages = [<PrivateIdeaWorkspace key="ideas" />, <PrivateIdeaWorkspace key="idea" sessionId="idea:skip-target" />,
    <PrivateNewsWorkspace key="news" projectId="project:skip-target" />];
  for (const page of pages) {
    const html = renderToStaticMarkup(page);
    assert.equal((html.match(/id="private-main"/g) ?? []).length, 1);
    assert.equal((html.match(/<main\b/g) ?? []).length, 1);
    assert.match(html, /<main id="private-main"/);
  }
});
