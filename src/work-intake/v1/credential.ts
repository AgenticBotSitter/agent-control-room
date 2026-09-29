import type { AuthenticatedPrincipal } from "../../security";
import type { WorkBatchServiceV1 } from "./service";

/**
 * The protected installation owns the secret comparison and returns only this
 * normalized proof. Credential bytes never enter a proposal, database row,
 * command-line argument, receipt, or audit event.
 */
export interface WorkIntakeCredentialVerifierPortV1 {
  verify(credential: unknown, now: string): Promise<AuthenticatedPrincipal>;
}

export class CredentialedWorkBatchServiceV1 {
  constructor(private readonly verifier: WorkIntakeCredentialVerifierPortV1,
    private readonly service: WorkBatchServiceV1, private readonly now: () => string = () => new Date().toISOString()) {}

  async submit(input: { credential: unknown; projectId: string; rawProposal: string;
    idempotencyKey: string }) {
    const now = this.now(), principal = await this.verifier.verify(input.credential, now);
    return this.service.submit({ ...input, principal, now });
  }

  async status(input: { credential: unknown; projectId: string; batchId: string }) {
    const now = this.now(), principal = await this.verifier.verify(input.credential, now);
    return this.service.status({ ...input, principal, now });
  }

  async list(input: { credential: unknown; projectId: string }) {
    const now = this.now(), principal = await this.verifier.verify(input.credential, now);
    return this.service.list({ ...input, principal, now });
  }
}
