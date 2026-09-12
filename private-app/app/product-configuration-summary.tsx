"use client";

import type { ProductConfigurationV1 } from "../../src/config/v1/product-configuration";

const moduleLabels: Record<keyof ProductConfigurationV1["modules"], string> = {
  ideaLab: "Idea Lab",
  news: "News and research",
  sessionObservations: "Session observations",
};

export function ProductConfigurationSummary({ configuration }: { configuration?: Readonly<ProductConfigurationV1> }) {
  if (!configuration) return <section className="private-panel" aria-labelledby="configuration-title">
    <h2 id="configuration-title">Product configuration</h2>
    <p>No portable presentation configuration is currently available to this view. The neutral Control Room shell remains in effect.</p>
    <p className="private-note">This page never substitutes a saved, sample, or private configuration. Refresh after access or configuration setup is restored.</p>
  </section>;

  const enabledModules = (Object.keys(configuration.modules) as (keyof ProductConfigurationV1["modules"])[])
    .filter(module => configuration.modules[module]);
  return <section className="private-panel" aria-labelledby="configuration-title">
    <h2 id="configuration-title">Product configuration</h2>
    <p>These are the non-secret presentation settings loaded for this workspace. They are read-only here; changing them requires the configured owner workflow.</p>
    <dl className="private-configuration-list">
      <div><dt>Display name</dt><dd>{configuration.displayName}</dd></div>
      <div><dt>Default timezone</dt><dd>{configuration.defaultTimezone}</dd></div>
      <div><dt>Enabled modules</dt><dd>{enabledModules.length ? enabledModules.map(module => moduleLabels[module]).join(", ") : "None"}</dd></div>
    </dl>
    <h3>Project templates</h3>
    <ul className="private-configuration-templates">
      {configuration.projectTemplates.map(template => <li key={template.id}><strong>{template.displayName}</strong>
        <span>{template.enabledModules.length ? template.enabledModules.map(module => moduleLabels[module]).join(", ") : "No optional modules"}</span></li>)}
    </ul>
    <h3>Documented UI limits</h3>
    <dl className="private-configuration-list">
      <div><dt>Projects</dt><dd>{configuration.limits.maxProjects.toLocaleString()}</dd></div>
      <div><dt>Tasks per project</dt><dd>{configuration.limits.maxTasksPerProject.toLocaleString()}</dd></div>
      <div><dt>Results per task</dt><dd>{configuration.limits.maxResultsPerTask.toLocaleString()}</dd></div>
      <div><dt>Article sources</dt><dd>{configuration.limits.maxArticleSources.toLocaleString()}</dd></div>
      <div><dt>Idea participants</dt><dd>{configuration.limits.maxIdeaParticipants.toLocaleString()}</dd></div>
    </dl>
    <p className="private-note">These ceilings describe this interface configuration. They do not grant authority, configure credentials, start services, or prove current capacity.</p>
  </section>;
}
