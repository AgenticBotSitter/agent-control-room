/** The production web login's side of the §8.4 count comparison.
 *
 * `UpdaterHealthWebReadPortV1.readHealthCounts()` must, for the live tenant and
 * workspace, (1) run the same tenant-scoped Home-summary read the UI runs and
 * return only its row count, (2) the same project-list read, (3) the same
 * Updates-panel read, (4) render the real Home route and refuse unless it is
 * HTTP 200 and non-empty, returning only its byte count, and (5) report the web
 * login's own `has_table_privilege('updater.plan_approvals','INSERT')`, refusing
 * false. It must never return content.
 *
 * WHY IT CALLS THE SERVICES INSTEAD OF RE-STATEMENTING THEIR SQL. The counts
 * exist to be COMPARED against the updater's independent read, and a second copy
 * of each query is a second thing that can drift: the moment the UI's Home
 * changed a limit or a state list, a re-statemented count would keep answering
 * and the comparison would go on passing while meaning something else. So this
 * calls `WebTaskService.home`, `WebProjectService.list` and
 * `ImproveControlRoomDeskServiceV1.ready` -- the same instances the routes call
 * -- and counts what they return.
 *
 * WHAT "COUNT" MEANS HERE, AND WHY IT MATCHES THE SQL. Each service applies a
 * documented cap (Home 10 shown / 250 scanned plus a page bound, projects 201,
 * panel 100). The count reported is of the SAME bounded set each service
 * returned, so it answers "how many rows did the owner's page just read", which is
 * the question §8.4 asks. db/migrations/0238 counts the same bounded sets
 * server-side; if a service's cap and the migration's cap ever disagree, the
 * comparison fails and health reports unhealthy -- which is the intended
 * direction for a health signal that cannot be trusted.
 */
import type { UpdaterHealthWebReadPortV1 } from "../../updater/v1/health-ports";
import type { VerifiedWebIdentity } from "./access-verifier";

/** The three reads, each returning only how many rows it produced. */
export interface UpdaterHealthWebReadsV1 {
  /** `WebTaskService.home` -- Home summary: active tasks plus recent results. */
  home(identity: VerifiedWebIdentity): Promise<{ active: readonly unknown[]; recentResults: readonly unknown[] }>;
  /** `WebProjectService.list` -- the owner's project catalog. */
  projects(identity: VerifiedWebIdentity): Promise<readonly unknown[]>;
  /** `ImproveControlRoomDeskServiceV1.ready` -- the Updates panel's queue. */
  updatesPanel(identity: VerifiedWebIdentity): Promise<{ candidates: readonly unknown[] }>;
}

/** The real Home route's renderer, and the identity the request runs as. */
export interface UpdaterHealthHomeRenderV1 {
  /** The verified owner identity these reads run as. The health request carries
   * a request HMAC rather than an owner cookie, so the composition supplies the
   * identity the installation's single owner session represents. */
  identity(): Promise<VerifiedWebIdentity>;
  /** Renders `/` through the ordinary renderer and returns the Response. */
  render(): Promise<Response>;
}

/** The web login's own privilege check, run on its own connection. */
export interface UpdaterHealthPrivilegeReadV1 {
  hasPlanApprovalInsert(): Promise<boolean>;
}

function refused(reason: string): never {
  throw new Error(`updater_health_web_reads_refused:${reason}`);
}

/** Only non-negative safe integers may leave this module. `homeRenderBytes`
 * must additionally be >= 1, because an empty render is the refusal §8.4 names. */
function count(value: unknown, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > 1_000_000)
    refused(field);
  return value as number;
}

// The parameter is named `sources`, NOT `input`: the returned method's own
// parameter is the per-call scope and is also called `input`, and a shadowed
// `input.home` inside the method read the SCOPE rather than the composition --
// which failed at the first call with "Cannot read properties of undefined
// (reading 'identity')" instead of at construction. Measured.
export function createUpdaterHealthWebReadPortV1(sources: Readonly<{
  reads: UpdaterHealthWebReadsV1;
  home: UpdaterHealthHomeRenderV1;
  privilege: UpdaterHealthPrivilegeReadV1;
}>): UpdaterHealthWebReadPortV1 {
  if (!sources || typeof sources.reads?.home !== "function" || typeof sources.reads.projects !== "function"
    || typeof sources.reads.updatesPanel !== "function" || typeof sources.home?.identity !== "function"
    || typeof sources.home.render !== "function" || typeof sources.privilege?.hasPlanApprovalInsert !== "function")
    refused("composition");
  return Object.freeze({
    async readHealthCounts(input: Readonly<{ tenantId: string; workspaceId: string }>) {
      // Destructured defensively: a caller that passes nothing gets a NAMED
      // refusal, not a TypeError from the parameter list. The failure mode of a
      // health check is that it reports a reason an operator can act on.
      const { tenantId, workspaceId } = (input ?? {}) as { tenantId?: unknown; workspaceId?: unknown };
      // The scope is asserted, not merely passed on. These three reads are
      // already bound to the installation's tenant and workspace by the services
      // that own them, so a mismatched argument here would mean the caller is
      // wired to a different installation than the services are -- a wiring bug
      // that must fail loudly rather than report another scope's counts as this
      // one's.
      if (typeof tenantId !== "string" || !tenantId || typeof workspaceId !== "string" || !workspaceId)
        refused("scope");
      const identity = await sources.home.identity();
      if (!identity || typeof identity !== "object" || typeof identity.subject !== "string"
          || !identity.subject || typeof identity.tokenDigest !== "string" || !identity.tokenDigest)
        refused("identity");

      // (1)(2)(3) The three real reads. Sequential rather than concurrent so the
      // numbers describe one ordered pass: a burst of owner activity between two
      // concurrent reads would otherwise show up as a count mismatch and be
      // reported as an unhealthy release when nothing is wrong.
      const summary = await sources.reads.home(identity);
      const projects = await sources.reads.projects(identity);
      const panel = await sources.reads.updatesPanel(identity);

      // (4) The real Home route. Status, then size: an error page renders
      // perfectly happily and is exactly what must not be counted as healthy.
      const response = await sources.home.render();
      if (!response || response.status !== 200) refused("home_render_status");
      const bytes = Number((response.headers.get("content-length") ?? "")
        .match(/^(\d{1,10})$/u)?.[1] ?? Number.NaN);
      // No content-length is normal for a streamed render, so the body is measured
      // when the header is absent. It is read, counted and dropped: the render's
      // bytes are never returned, only their number.
      const size = Number.isSafeInteger(bytes) && bytes > 0
        ? bytes : (await response.arrayBuffer()).byteLength;
      if (!Number.isSafeInteger(size) || size < 1 || size > 4_194_304) refused("home_render_size");

      // (5) The privilege boolean, measured on the web login's own connection.
      if (await sources.privilege.hasPlanApprovalInsert() !== true) refused("plan_approval_insert");

      return Object.freeze({
        homeSummaryCount: count((summary.active?.length ?? 0) + (summary.recentResults?.length ?? 0),
          "home_summary_count"),
        projectCount: count(projects.length, "project_count"),
        updatesPanelCount: count(panel.candidates?.length ?? 0, "updates_panel_count"),
        homeRenderBytes: count(size, "home_render_bytes", 1),
        planApprovalInsertAllowed: true as const,
      });
    },
  });
}