import { ownerReviewFixture } from "./web-owner-review";
import { WebTaskVerificationService } from "../../src/web/v1/task-verification-service";
import { sha256Digest } from "../../src/security";
import type { DatabaseClient, DatabaseSession } from "../../src/persistence/database";
import type { TaskVerificationDraft } from "../../src/web/v1/task-verification-wire";
import { instant } from "../hermes-native-fixture";

export async function ownerVerificationFixture(overrides?: Parameters<typeof ownerReviewFixture>[0]) {
  const f = await ownerReviewFixture(overrides);
  const scenario = { scenarioId: "scenario:content", label: "Check the private content",
    instructions: "Read the exact result and describe whether its content meets the stated objective.",
    acceptanceProfileId: f.profile.id, acceptanceProfileDigest: sha256Digest(f.profile) };
  const config: ConstructorParameters<typeof WebTaskVerificationService>[2] = {
    ...f.ownerConfig, manualVerificationScenarios: [scenario] };
  const createVerifications = (db: DatabaseClient = f.db, clock = () => instant + 6000, extra: Partial<typeof config> = {}) =>
    new WebTaskVerificationService(db, f.scope, { ...config, ...extra }, clock);
  const verificationDraft: TaskVerificationDraft = { artifactId: f.artifact.artifactId, targetId: f.target.id,
    targetDigest: sha256Digest(f.target), contentHash: f.artifact.contentHash, scenarioId: scenario.scenarioId,
    instructionsDigest: sha256Digest(scenario), outcome: "passed", note: "I read the exact result and confirmed its useful private content." };
  return { ...f, scenario, verificationConfig: config, createVerifications, verifications: createVerifications(), verificationDraft };
}

export function interceptVerificationDatabase(db: DatabaseClient, after: (sql: string) => void): DatabaseClient {
  const session = (tx: DatabaseSession): DatabaseSession => ({ async query<T>(sql: string, params?: unknown[]) {
    const result = await tx.query<T>(sql, params); after(sql); return result;
  } });
  return { query: db.query.bind(db), transaction: work => db.transaction(tx => work(session(tx))),
    transactionWithPreCommitCheck: (work, check) => db.transactionWithPreCommitCheck(tx => work(session(tx)), check) };
}
