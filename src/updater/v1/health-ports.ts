/** Aggregate-only database boundary for updater health. Implementations belong
 * to the database package; the health contract never receives row content. */
export type UpdaterHealthComparisonCountsV1 = Readonly<{
  /** Rows returned by the same tenant-scoped Home summary read used by the UI. */
  homeSummaryCount: number;
  /** Rows returned by the same tenant-scoped project-list read used by the UI. */
  projectCount: number;
  /** Rows returned by the same tenant-scoped Updates-panel read used by the UI. */
  updatesPanelCount: number;
}>;

/** Runs independently through the updater's production database authority.
 * The adapter is pre-bound to the live tenant/workspace and returns only the
 * three counts that are compared with the production web login's result. */
export interface UpdaterHealthAuthorityReadPortV1 {
  readHealthCounts(): Promise<UpdaterHealthComparisonCountsV1>;
}

/** Runs through the production web login. The adapter must execute the real
 * Home-summary, project-list and Updates-panel reads for this identity, render
 * the real Home route, refuse unless that render is HTTP 200 and non-empty,
 * and require INSERT on updater.plan_approvals for current_user. */
export interface UpdaterHealthWebReadPortV1 {
  readHealthCounts(input: Readonly<{ tenantId: string; workspaceId: string }>): Promise<Readonly<
    UpdaterHealthComparisonCountsV1 & {
      /** Byte count of the non-empty successful Home render; never its content. */
      homeRenderBytes: number;
      /** Exact result of the production-login privilege check; false is unhealthy. */
      planApprovalInsertAllowed: true;
    }
  >>;
}
