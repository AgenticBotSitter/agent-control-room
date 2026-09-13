import { z } from "zod";
import { CodexCanonicalResultPublisherV1 } from "../../artifacts/v1/codex-results";
import {
  codexResultReturnBodySchemaV1,
  type CodexResultReturnExpectationV1,
} from "../../harness/codex-v1/result-return";
import {
  signedCodexPhysicalQualificationReceiptSchemaV1,
  verifyCodexPhysicalQualificationReceiptV1,
} from "../../harness/codex-v1/result-publication-contract";
import type { AuthenticatedFrameResult } from "../../node-protocol/v1/authentication";
import type { CodexResultReturnChannelV1, CodexResultReturnIntakeV1 } from "../../node-control/server-node-session";

const positiveSafeInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export type CodexResultIntakeSettingsV1 = Readonly<{
  qualificationReceipt: unknown;
  qualificationPublicKeySpki: string;
  qualificationMaximumAgeMs: number;
}>;

export function captureCodexResultIntakeSettingsV1(input: CodexResultIntakeSettingsV1) {
  try {
    const receipt = signedCodexPhysicalQualificationReceiptSchemaV1.parse(input.qualificationReceipt);
    const qualificationPublicKeySpki = z.string().min(1).max(8192).parse(input.qualificationPublicKeySpki);
    const qualificationMaximumAgeMs = positiveSafeInteger.parse(input.qualificationMaximumAgeMs);
    verifyCodexPhysicalQualificationReceiptV1({
      receipt,
      expectedQualificationId: receipt.body.qualificationId,
      expectedBodyDigest: receipt.body.bodyDigest,
      expectedSignerKeyId: receipt.body.qualificationSignerKeyId,
      publicKeySpki: qualificationPublicKeySpki,
    });
    return Object.freeze({
      qualificationReceipt: structuredClone(receipt),
      qualificationPublicKeySpki,
      qualificationMaximumAgeMs,
    });
  } catch {
    throw new Error("codex_result_intake_configuration_invalid");
  }
}

function unavailable(): never {
  throw new Error("codex_result_intake_unavailable");
}

/**
 * Server-only bridge from one authenticated return frame to the existing canonical
 * publisher. It adds no protocol, result model, storage, review or completion path.
 */
export class CodexResultIntakeV1 implements CodexResultReturnIntakeV1 {
  private readonly settings: ReturnType<typeof captureCodexResultIntakeSettingsV1>;

  constructor(
    private readonly publisher: CodexCanonicalResultPublisherV1,
    settings: CodexResultIntakeSettingsV1,
  ) {
    if (!publisher || typeof publisher.capture !== "function") {
      throw new Error("codex_result_intake_configuration_invalid");
    }
    this.settings = captureCodexResultIntakeSettingsV1(settings);
  }

  expectation(authenticated: AuthenticatedFrameResult, channel: CodexResultReturnChannelV1): CodexResultReturnExpectationV1 {
    try {
      const frame = authenticated.frame;
      if (frame.type !== "harness.codex.result.return") return unavailable();
      const body = codexResultReturnBodySchemaV1.parse(frame.body);
      const receipt = this.settings.qualificationReceipt;
      if (receipt.body.tenantId !== channel.tenantId || receipt.body.nodeId !== channel.nodeId
        || receipt.body.qualificationId !== body.physicalQualification.qualificationId
        || receipt.body.bodyDigest !== body.physicalQualification.receiptBodyDigest
        || receipt.body.qualificationSignerKeyId !== body.physicalQualification.signerKeyId) return unavailable();
      if (receipt.body.connectorProfileDigest !== channel.connectorProfileDigest) return unavailable();
      return Object.freeze({
        identity: structuredClone(channel.identity),
        activation: structuredClone(channel.activation),
        connector: Object.freeze({ profileId: receipt.body.connectorProfileId,
          profileDigest: channel.connectorProfileDigest }),
        connectionId: channel.connectionId,
        nodeActorId: channel.nodeId,
        nodeKeyId: channel.nodeKeyId,
        serverActorId: channel.serverId,
        serverKeyId: channel.serverKeyId,
        qualificationMaximumAgeMs: this.settings.qualificationMaximumAgeMs,
        qualificationPublicKeySpki: this.settings.qualificationPublicKeySpki,
        qualificationReceipt: structuredClone(receipt),
      });
    } catch {
      return unavailable();
    }
  }

  async publish(authenticated: AuthenticatedFrameResult, assertCurrent: () => unknown): Promise<void> {
    let body: z.infer<typeof codexResultReturnBodySchemaV1>;
    try {
      const frame = authenticated.frame;
      if (frame.type !== "harness.codex.result.return") return unavailable();
      body = codexResultReturnBodySchemaV1.parse(frame.body);
    } catch {
      return unavailable();
    }
    const bytes = new TextEncoder().encode(body.publication.result.text);
    const captured = await this.publisher.capture({
      publication: body.publication,
      terminalEvidence: body.terminalEvidence,
      qualificationReceipt: this.settings.qualificationReceipt,
      bytes,
      assertCurrent,
    });
    if (captured.receipt.tenantId !== body.identity.tenantId
      || captured.receipt.projectId !== body.identity.projectId
      || captured.receipt.jobId !== body.identity.jobId
      || captured.receipt.attemptId !== body.identity.attemptId
      || captured.receipt.runId !== body.identity.runId
      || captured.receipt.nodeId !== body.identity.nodeId
      || captured.receipt.contentHash !== body.result.contentHash
      || captured.receipt.sizeBytes !== body.result.sizeBytes
      || captured.target.tenantId !== body.identity.tenantId
      || captured.target.projectId !== body.identity.projectId
      || captured.target.subjectId !== body.identity.jobId
      || captured.target.subjectDigest !== body.result.contentHash) return unavailable();
    assertCurrent();
  }
}
