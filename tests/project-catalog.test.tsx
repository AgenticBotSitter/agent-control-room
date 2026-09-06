import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectCatalog } from "../app/components/project-catalog.tsx";
import { ProjectCatalogNavigation } from "../app/components/project-catalog-navigation.tsx";
import { PrivateProjectWorkspace } from "../private-app/app/workspace.tsx";

test("separate project tabs use isolated native links without project mutations", () => {
  const projects = [
    { projectId: "project:first", title: "Same title", summary: "", lifecycle: "active" as const },
    { projectId: "project:second", title: "Same title", summary: "", lifecycle: "archived" as const },
  ];
  const html = renderToStaticMarkup(<ProjectCatalog state="ready" projects={projects} />);
  assert.equal((html.match(/target="_blank"/g) ?? []).length, 2);
  assert.equal((html.match(/rel="noopener noreferrer"/g) ?? []).length, 2);
  for (const id of ["first", "second"]) assert.match(html,
    new RegExp(`class="private-project-new-tab" href="/projects/project%3A${id}" target="_blank"`));
  assert.doesNotMatch(html, /<button|<form|onclick|window\.open|role="tab"/i);
  for (const state of ["loading", "unavailable"] as const)
    assert.doesNotMatch(renderToStaticMarkup(<ProjectCatalog state={state} projects={projects} />), /Same title|target="_blank"/);
  const shell = renderToStaticMarkup(<PrivateProjectWorkspace />);
  assert.match(shell, /Closing a tab does not stop work/);
  assert.doesNotMatch(shell, /Live agent assignment is not connected yet/);
});

test("catalog distinguishes loading, unavailable and an actually empty catalog", () => {
  assert.match(renderToStaticMarkup(<ProjectCatalog state="loading" projects={[]} />), /Loading projects/);
  assert.match(renderToStaticMarkup(<ProjectCatalog state="unavailable" projects={[]} />), /unavailable/);
  assert.match(renderToStaticMarkup(<ProjectCatalog state="ready" projects={[]} />), /No projects yet/);
});
test("paged catalog labels Idea origin, scopes archive headings to the page and never claims a denied list is empty globally", () => {
  const html = renderToStaticMarkup(<ProjectCatalog state="ready" paginated projects={[
    { projectId: "project.idea:a", title: "Idea", summary: "Purpose", lifecycle: "archived", origin: "idea_lab" },
  ]} />);
  assert.match(html, /From Idea Lab/); assert.match(html, /Archived on this page/); assert.match(html, /project.idea%3Aa/);
  assert.match(renderToStaticMarkup(<ProjectCatalog state="ready" paginated projects={[]} />), /on this page with your current access/);
  const navigation = renderToStaticMarkup(<ProjectCatalogNavigation after="project:a" nextCursor="project:z" count={50} />);
  assert.match(navigation, /href="\/projects"/); assert.match(navigation, /after=project%3Az/);
  assert.match(navigation, /50 projects on this page/); assert.doesNotMatch(navigation, /onclick|onClick/);
  assert.doesNotMatch(renderToStaticMarkup(<ProjectCatalogNavigation nextCursor={null} count={0} />), /Next page|First page/);
});
test("catalog escapes text, encodes project links and keeps archived projects discoverable", () => {
  const html = renderToStaticMarkup(<ProjectCatalog state="ready" selectedProjectId="project:a/b" projects={[
    { projectId: "project:a/b", title: "<script>no</script>", summary: "Private purpose", lifecycle: "active" },
    { projectId: "project:old", title: "Old project", summary: "", lifecycle: "archived" },
  ]} />);
  assert.match(html, /project%3Aa%2Fb/); assert.match(html, /aria-current="page"/); assert.doesNotMatch(html, /<script>/);
  assert.match(html, /Archived projects/); assert.match(html, /Old project/);
});
