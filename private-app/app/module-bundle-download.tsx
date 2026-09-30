/**
 * Plain download links for a registered module's bundle and a project's
 * pack. A same-origin GET carries the owner's session exactly the way every
 * other read in this app does, so no fetch wrapper is needed here: the
 * browser's own download handling (and the server's Content-Disposition
 * file name) does the rest. Neither link installs, executes, or changes
 * anything; both are inert exports.
 */

const MODULE_ID_PATTERN = /^[a-z][A-Za-z0-9.-]{2,63}$/;
const PROJECT_ID_PATTERN = /^project:[A-Za-z0-9:_-]{1,160}$/;

export function ModuleBundleDownloadLink({ moduleId, moduleName }: { moduleId: string; moduleName: string }) {
  if (!MODULE_ID_PATTERN.test(moduleId)) return null;
  return (
    <a className="private-download-link" data-field="module-bundle-download"
      href={`/api/v1/modules/${encodeURIComponent(moduleId)}/bundle`}>
      Download {moduleName} module bundle
    </a>
  );
}

export function ProjectPackDownloadLink({ projectId, projectTitle }: { projectId: string; projectTitle: string }) {
  if (!PROJECT_ID_PATTERN.test(projectId)) return null;
  return (
    <a className="private-download-link" data-field="project-pack-download"
      href={`/api/v1/projects/${encodeURIComponent(projectId)}/pack`}>
      Download &ldquo;{projectTitle}&rdquo; as a project pack
    </a>
  );
}
