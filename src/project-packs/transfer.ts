import { getRegisteredModuleManifestV1 } from "../modules/v1/registry";
import { buildProjectPackV2, projectPackDigestV2, type ProjectPackV2 } from "./v2/project-pack";

/**
 * Exports one project as a portable, inert project pack file the owner can
 * download and hand to another installation. Per the project-pack contract,
 * this carries only the descriptive fields a pack is allowed to carry (title,
 * summary, exact enabled-module id/version references): never project IDs,
 * tasks, results, credentials, or live settings. This reads nothing from the
 * database itself; the caller supplies the already-authorized project view.
 */

export interface ProjectPackSourceV1 {
  readonly title: string;
  readonly summary: string;
  readonly enabledModules?: readonly string[];
}

export interface ProjectPackDownloadV1 {
  readonly pack: Readonly<ProjectPackV2>;
  readonly digest: string;
  readonly fileName: string;
}

const FILE_NAME_UNSAFE = /[^a-z0-9-]+/gi;
const MAX_SLUG_LENGTH = 60;
/** A pack's summary is required text; a project's own summary may be empty. */
const NO_SUMMARY_TEXT = "No summary provided.";

function fileNameSlug(title: string): string {
  const slug = title.toLowerCase().replace(FILE_NAME_UNSAFE, "-").replace(/^-+|-+$/g, "").slice(0, MAX_SLUG_LENGTH);
  return slug.length > 0 ? slug : "project";
}

/**
 * Builds the exact canonical pack for one project's current title, summary,
 * and enabled modules (resolved to the exact version this installation has
 * registered for each), plus its digest and a safe download file name.
 */
export function exportProjectAsPackV1(project: ProjectPackSourceV1): Readonly<ProjectPackDownloadV1> {
  const modules = [...new Set(project.enabledModules ?? [])]
    .map(id => { const manifest = getRegisteredModuleManifestV1(id); return { id: manifest.id, version: manifest.version }; });
  const summary = project.summary.trim().length > 0 ? project.summary : NO_SUMMARY_TEXT;
  const pack = buildProjectPackV2({ title: project.title, summary, modules });
  return Object.freeze({ pack, digest: projectPackDigestV2(pack), fileName: `${fileNameSlug(project.title)}.project-pack.json` });
}
