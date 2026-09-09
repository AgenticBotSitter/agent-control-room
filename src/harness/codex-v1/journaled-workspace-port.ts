import type { CodexWorkspacePortV1 } from "./workspace";
import type { SqliteBridgeJournal } from "../../node-bridge/journal";
import { parseWorkspaceIntent } from "../../node-bridge/workspace-intent";
import { sha256Digest } from "../../security/canonical-digest";

/** Trusted node composition only; current authenticated admission is required.
 * Existing reservations never retry creation without the future recovery path.
 * Removal requires separately supplied current authority and confirmed port completion.
 */
export function journaledWorkspacePort(input: {
  port: CodexWorkspacePortV1;
  journal: Pick<SqliteBridgeJournal, "reserveWorkspaceIntent" | "recordWorkspaceCreation" | "reserveWorkspaceRemoval" | "recordWorkspaceRemoved">;
  intent: unknown;
  assertCurrent: () => void;
  assertRemovalCurrent?: () => void;
}): CodexWorkspacePortV1 {
  const { port, journal, assertCurrent, assertRemovalCurrent } = input;
  const intent = parseWorkspaceIntent(input.intent), digest = sha256Digest(intent);
  return {
    inspectExisting: path => port.inspectExisting(path),
    createDetachedWorktree: async request => {
      if (request.repositoryRealPath !== intent.repositoryRoot || request.checkoutPath !== intent.checkoutPath
        || request.revision !== intent.revision) throw new Error("workspace_request_binding_invalid");
      if (journal.reserveWorkspaceIntent(intent, assertCurrent) !== "recorded")
        throw new Error("workspace_reconciliation_required");
      assertCurrent();
      const evidence = await port.createDetachedWorktree({ repositoryRealPath: intent.repositoryRoot,
        checkoutPath: intent.checkoutPath, revision: intent.revision });
      journal.recordWorkspaceCreation(digest, evidence, assertCurrent);
      return evidence;
    },
    removeWorktree: async request => {
      if (!assertRemovalCurrent) throw new Error("workspace_removal_authority_required");
      if (request.repositoryRealPath !== intent.repositoryRoot || request.checkoutPath !== intent.checkoutPath)
        throw new Error("workspace_request_binding_invalid");
      if (journal.reserveWorkspaceRemoval(digest, assertRemovalCurrent) !== "recorded")
        throw new Error("workspace_reconciliation_required");
      assertRemovalCurrent();
      await port.removeWorktree({ repositoryRealPath: intent.repositoryRoot, checkoutPath: intent.checkoutPath });
      journal.recordWorkspaceRemoved(digest);
    },
  };
}
