import type { DatabaseClient } from "../../persistence/database";
import type { VerifiedWebIdentity } from "../../web/v1/access-verifier";
import { WebAccessError } from "../../web/v1/access-verifier";
import { WebSessionAuthority } from "../../web/v1/session-authority";
import { isModuleSemverV1 } from "./manifest";
import { exportModuleBundleV1, type ModuleDownloadBundleV1, type ModuleSigningKeyV1 } from "./transfer";

/**
 * Owner-attended module bundle download. This is deliberately separate from
 * `ModuleInstallApprovalServiceV1`: it never reads or writes an approval, it
 * only gates a static, read-only export behind the same `modules.read` grant
 * and the same session/authority machinery. It executes and migrates nothing.
 */

const MODULE_ID_PATTERN = /^[a-z][A-Za-z0-9.-]{2,63}$/;

export class ModuleTransferServiceV1 {
  readonly #authority: WebSessionAuthority;

  constructor(db: DatabaseClient, scope: { tenantId: string; workspaceId: string },
    private readonly signingKey: ModuleSigningKeyV1 | null = null, clock: () => number = Date.now) {
    this.#authority = new WebSessionAuthority(db, scope, clock, "module");
  }

  async downloadModule(identity: VerifiedWebIdentity, moduleId: string, version?: string): Promise<Readonly<ModuleDownloadBundleV1>> {
    if (typeof moduleId !== "string" || !MODULE_ID_PATTERN.test(moduleId)) throw new WebAccessError("invalid_request");
    if (version !== undefined && (typeof version !== "string" || !isModuleSemverV1(version))) throw new WebAccessError("invalid_request");
    return this.#authority.authenticated(identity, async (_tx, actor) => {
      actor.require("modules.read");
      try { return exportModuleBundleV1(moduleId, version, this.signingKey); }
      catch { throw new WebAccessError("not_found"); }
    }, { readOnly: true });
  }
}
