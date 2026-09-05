import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectCatalog } from "../app/components/project-catalog.tsx";

test("catalog distinguishes loading, unavailable and an actually empty catalog", () => {
  assert.match(renderToStaticMarkup(<ProjectCatalog state="loading" projects={[]} />), /Loading projects/);
  assert.match(renderToStaticMarkup(<ProjectCatalog state="unavailable" projects={[]} />), /unavailable/);
  assert.match(renderToStaticMarkup(<ProjectCatalog state="ready" projects={[]} />), /No projects yet/);
});
test("catalog escapes text, encodes project links and keeps archived projects discoverable", () => {
  const html = renderToStaticMarkup(<ProjectCatalog state="ready" selectedProjectId="project:a/b" projects={[
    { projectId: "project:a/b", title: "<script>no</script>", summary: "Private purpose", lifecycle: "active" },
    { projectId: "project:old", title: "Old project", summary: "", lifecycle: "archived" },
  ]} />);
  assert.match(html, /project%3Aa%2Fb/); assert.match(html, /aria-current="page"/); assert.doesNotMatch(html, /<script>/);
  assert.match(html, /Archived projects/); assert.match(html, /Old project/);
});
