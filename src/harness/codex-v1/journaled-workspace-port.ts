import type { CodexWorkspacePortV1 } from "./workspace";
import type { SqliteBridgeJournal } from "../../node-bridge/journal";
import { parseWorkspaceIntent } from "../../node-bridge/workspace-intent";
import { sha256Digest } from "../../security/canonical-digest";

/** Trusted node composition only; current authenticated admission is required.
 * Existing reservations never retry creation without the future recovery path.
 * Removal remains disabled until its durable intent/readback transition exists.
 */
export function journaledWorkspacePort(input: {
  port: CodexWorkspacePortV1;
  journal: Pick<SqliteBridgeJournal, "reserveWorkspaceIntent" | "recordWorkspaceCreation">;
  intent: unknown;
  assertCurrent: () => void;
}): CodexWorkspacePortV1 {
  const { port, journal, assertCurrent } = input;
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
    removeWorktree: async () => { throw new Error("workspace_removal_journal_required"); },
  };
}
