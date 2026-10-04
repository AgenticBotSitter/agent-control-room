import { randomUUID } from "node:crypto";
import { basename, isAbsolute, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalJson } from "../../security/canonical-digest";
import { type InstallationPlanV1, installationPlanReplayMatchesV1,
  verifyInstallationPlanV1 } from "./installation-plan";
import { type InstallationPlanJournalEntryIdentityV1 as Identity,
  type InstallationPlanJournalEntryV1,
  type InstallationPlanJournalStorageOperationV1,
  type InstallationPlanJournalStorageSessionFactoryV1,
  type InstallationPlanJournalStorageSessionV1,
  openInstallationPlanFilesystemStorageSessionV1 } from "./installation-plan-journal-storage-session";

const MAX_PLAN_BYTES = 64 * 1024;
const MAX_REVISIONS = 10_000;
const installationIdPattern = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const INSTALLATION_PLAN_JOURNAL_V1 = "control-room.installation-plan-journal/v1" as const;

export type InstallationPlanJournalAppendResultV1 = Readonly<{
  schema: typeof INSTALLATION_PLAN_JOURNAL_V1;
  installationId: string;
  revision: number;
  planDigest: string;
  replayed: boolean;
  enablesAuthority: false;
  startsService: false;
  startsWorker: false;
}>;

type Configuration = Readonly<{ rootDirectory: string; installationId: string; ownerUid: number }>;
type PublicationWitness = Readonly<{ schema: "control-room.installation-plan-publication/v1"; revision: number;
  tempName: string; planDigest: string }>;

const unavailable = (): never => { throw new Error("installation_plan_journal_unavailable"); };
const conflict = (): never => { throw new Error("installation_plan_journal_conflict"); };
class PublicationSettling extends Error {
  constructor() { super("installation_plan_journal_unavailable"); }
}
const settling = (): never => { throw new PublicationSettling(); };

function capture(input: unknown): Configuration {
  if (!input || typeof input !== "object" || Array.isArray(input)) return unavailable();
  const value = input as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "installationId,ownerUid,rootDirectory"
    || typeof value.rootDirectory !== "string" || !isAbsolute(value.rootDirectory)
    || resolve(value.rootDirectory) !== value.rootDirectory || basename(value.rootDirectory) === ""
    || typeof value.installationId !== "string" || !installationIdPattern.test(value.installationId)
    || !Number.isSafeInteger(value.ownerUid) || (value.ownerUid as number) < 0) return unavailable();
  return Object.freeze({ rootDirectory: value.rootDirectory, installationId: value.installationId,
    ownerUid: value.ownerUid as number });
}

const same = (left: unknown, right: unknown) => canonicalJson(left) === canonicalJson(right);

function legalAdvance(previous: InstallationPlanV1, next: InstallationPlanV1): boolean {
  if (previous.topologyPlanDigest !== next.topologyPlanDigest || previous.releaseDigest !== next.releaseDigest) return false;
  const changed = previous.stages.map((value, index) => same(value, next.stages[index])).map((value, index) => value ? -1 : index)
    .filter(index => index >= 0);
  if (changed.length !== 1) return false;
  const index = changed[0]!, before = previous.stages[index]!, after = next.stages[index]!;
  if (before.stage !== after.stage || before.inputDigest !== after.inputDigest || after.recordedRevision !== next.revision) return false;
  if (before.state === "not_started" && after.state === "running")
    return after.outcomeDigest === undefined;
  return before.state === "running" && (after.state === "passed" || after.state === "failed" || after.state === "uncertain")
    && after.outcomeDigest !== undefined;
}

function legalRefresh(previous: InstallationPlanV1, next: InstallationPlanV1): boolean {
  const bindingChanged = previous.topologyPlanDigest !== next.topologyPlanDigest || previous.releaseDigest !== next.releaseDigest;
  const changedAt = bindingChanged ? 0 : previous.stages.findIndex((value, index) => value.inputDigest !== next.stages[index]!.inputDigest);
  if (changedAt < 0) return false;
  if (previous.stages.slice(changedAt).some(value => value.state === "running" || value.state === "uncertain")) return false;
  if (previous.stages.slice(0, changedAt).some((value, index) => !same(value, next.stages[index]))) return false;
  return next.stages.slice(changedAt).every(value => value.state === "not_started"
    && value.outcomeDigest === undefined && value.recordedRevision === undefined);
}

function assertLegalHistoryTransition(previous: InstallationPlanV1, next: InstallationPlanV1): void {
  if (next.revision !== previous.revision + 1 || (!legalAdvance(previous, next) && !legalRefresh(previous, next))) conflict();
}

/**
 * Owner-private append-only persistence for the setup plan before PostgreSQL
 * exists. The supplied root must already exist and be privately owned. This
 * store never creates that root or performs any setup effect.
 */
export class InstallationPlanFilesystemJournalV1 {
  private readonly config: Configuration;
  private readonly openStorageSession: InstallationPlanJournalStorageSessionFactoryV1;

  constructor(input: unknown, openStorageSession: InstallationPlanJournalStorageSessionFactoryV1 =
  openInstallationPlanFilesystemStorageSessionV1) {
    this.config = capture(input);
    if (typeof openStorageSession !== "function") unavailable();
    this.openStorageSession = openStorageSession;
  }

  private targetName(revision: number) {
    return `${this.config.installationId}.installation-plan.revision-${revision.toString().padStart(10, "0")}.json`;
  }

  private tempName(revision: number, nonce: string) {
    return `${this.config.installationId}.installation-plan.revision-${revision.toString().padStart(10, "0")}.${nonce}.tmp`;
  }

  private witnessName(revision: number) {
    return `${this.config.installationId}.installation-plan.revision-${revision.toString().padStart(10, "0")}.publish.json`;
  }

  private async withSession<T>(operation: InstallationPlanJournalStorageOperationV1, signal: AbortSignal | undefined,
    run: (session: InstallationPlanJournalStorageSessionV1) => Promise<T>): Promise<T> {
    signal?.throwIfAborted();
    const session = await this.openStorageSession(Object.freeze({ operation, rootDirectory: this.config.rootDirectory,
      installationId: this.config.installationId, ownerUid: this.config.ownerUid, signal }));
    let result: T;
    try { result = await run(session); }
    finally { await session.close().catch(unavailable); }
    return result;
  }

  private validPrivateFile(entry: InstallationPlanJournalEntryV1, maximumBytes: number, linkCount: number, allowEmpty = false) {
    return entry.kind === "file" && entry.canonical && entry.ownerUid === this.config.ownerUid
      && entry.linkCount === linkCount && (entry.mode & 0o077) === 0
      && (entry.size > 0 || allowEmpty && entry.size === 0) && entry.size <= maximumBytes;
  }

  private async readPlan(revision: number, session: InstallationPlanJournalStorageSessionV1,
    expectedIdentity?: Identity, allowLinked = false): Promise<InstallationPlanV1> {
    try {
      const read = await session.readEntry(this.targetName(revision), MAX_PLAN_BYTES);
      if (!this.validPrivateFile(read.entry, MAX_PLAN_BYTES, allowLinked && read.entry.linkCount === 2 ? 2 : 1)
        || read.bytes.byteLength !== read.entry.size
        || expectedIdentity && (read.entry.identity.device !== expectedIdentity.device
          || read.entry.identity.inode !== expectedIdentity.inode)) unavailable();
      const plan = verifyInstallationPlanV1(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes)));
      if (plan.revision !== revision) unavailable();
      return plan;
    } catch (error) {
      if (error instanceof Error && (error.message === "installation_plan_journal_unavailable"
        || error.message === "installation_plan_invalid")) throw error;
      return unavailable();
    }
  }

  private async readWitness(revision: number, session: InstallationPlanJournalStorageSessionV1):
  Promise<{ value: PublicationWitness; identity: Identity } | undefined> {
    const name = this.witnessName(revision), before = await session.statEntry(name);
    if (!before) return undefined;
    if (!this.validPrivateFile(before, 1024, 1, true)) {
      // lstat may precede retirement while realpath follows it. Retry only a
      // private witness whose sole invalid property is that vanished pathname.
      if (this.validPrivateFile({ ...before, canonical: true }, 1024, 1, true)
        && !await session.statEntry(name)) settling();
      unavailable();
    }
    if (before.size === 0) settling();
    try {
      const read = await session.readEntry(name, 1024);
      if (read.entry.identity.device !== before.identity.device || read.entry.identity.inode !== before.identity.inode
        || !this.validPrivateFile(read.entry, 1024, 1)) unavailable();
      const raw: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(read.bytes));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) unavailable();
      const value = raw as Record<string, unknown>;
      const expectedTempPrefix = `${this.config.installationId}.installation-plan.revision-${revision.toString().padStart(10, "0")}.`;
      if (Object.keys(value).sort().join(",") !== "planDigest,revision,schema,tempName"
        || value.schema !== "control-room.installation-plan-publication/v1" || value.revision !== revision
        || typeof value.tempName !== "string" || !value.tempName.startsWith(expectedTempPrefix)
        || !value.tempName.endsWith(".tmp") || !uuidPattern.test(value.tempName.slice(expectedTempPrefix.length, -4))
        || typeof value.planDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.planDigest)) unavailable();
      return { value: Object.freeze(value as PublicationWitness),
        identity: read.entry.identity };
    } catch (error) {
      const current = await session.statEntry(name);
      if (!current) settling();
      if (error instanceof Error && error.message === "installation_plan_journal_unavailable") throw error;
      return unavailable();
    }
  }

  private async unlinkWitness(revision: number, witnessIdentity: Identity,
    session: InstallationPlanJournalStorageSessionV1, allowMissing = false) {
    await session.unlinkExact(this.witnessName(revision), witnessIdentity, allowMissing);
    await session.syncDirectory();
  }

  private async recoverPublishedRevision(revision: number, session: InstallationPlanJournalStorageSessionV1) {
    const targetName = this.targetName(revision), targetEntry = await session.statEntry(targetName);
    if (!targetEntry) {
      if (await this.readWitness(revision, session)) unavailable();
      return;
    }
    // Capture verified content while the target still has its publication alias.
    // A freed inode can be reused: device+inode alone cannot bind a later read to
    // this plan once another writer has retired the temp and witness.
    let publishingPlan: InstallationPlanV1 | undefined;
    if (targetEntry.linkCount !== 1) {
      if (!this.validPrivateFile(targetEntry, MAX_PLAN_BYTES, 2)) unavailable();
      publishingPlan = await this.readPlan(revision, session, targetEntry.identity, true);
    }
    const assertObservedContent = async (allowLinked = false) => {
      const currentPlan = await this.readPlan(revision, session, targetEntry.identity, allowLinked);
      if (currentPlan.planDigest !== publishingPlan?.planDigest) unavailable();
    };
    let witness: { value: PublicationWitness; identity: Identity } | undefined;
    try { witness = await this.readWitness(revision, session); }
    catch (error) {
      // Witness retirement can itself request a retry. Preserve the content
      // binding before the next pass takes a fresh target snapshot.
      if (error instanceof PublicationSettling && publishingPlan) await assertObservedContent(true);
      throw error;
    }
    if (targetEntry.linkCount === 1) {
      if (!witness) return;
      const plan = await this.readPlan(revision, session);
      if (plan.planDigest !== witness.value.planDigest) unavailable();
      if (await session.statEntry(witness.value.tempName)) unavailable();
      await this.unlinkWitness(revision, witness.identity, session, true);
      return;
    }
    if (!witness) {
      const current = await session.statEntry(targetName);
      if (current && this.validPrivateFile(current, MAX_PLAN_BYTES, 1)
        && current.identity.device === targetEntry.identity.device
        && current.identity.inode === targetEntry.identity.inode) {
        await assertObservedContent();
        return;
      }
      return unavailable();
    }
    const tempEntry = await session.statEntry(witness.value.tempName);
    if (!tempEntry) {
      const current = await session.statEntry(targetName);
      if (current && this.validPrivateFile(current, MAX_PLAN_BYTES, 1)
        && current.identity.device === targetEntry.identity.device
        && current.identity.inode === targetEntry.identity.inode) {
        await assertObservedContent();
        settling();
      }
      return unavailable();
    }
    // A writer can unlink the temp alias between lstat and canonical-path lookup.
    // Retry only the same private inode now held solely by the target; the next
    // pass still validates the plan, witness digest and publication identities.
    if (this.validPrivateFile({ ...tempEntry, canonical: true }, MAX_PLAN_BYTES, tempEntry.linkCount)
      && (tempEntry.linkCount === 1 || tempEntry.linkCount === 2)
      && tempEntry.identity.device === targetEntry.identity.device
      && tempEntry.identity.inode === targetEntry.identity.inode) {
      const current = await session.statEntry(targetName);
      if (current && this.validPrivateFile(current, MAX_PLAN_BYTES, 1)
        && current.identity.device === targetEntry.identity.device
        && current.identity.inode === targetEntry.identity.inode
        && !await session.statEntry(witness.value.tempName)) {
        await assertObservedContent();
        settling();
      }
    }
    if (!this.validPrivateFile(tempEntry, MAX_PLAN_BYTES, 2)
      || tempEntry.identity.device !== targetEntry.identity.device
      || tempEntry.identity.inode !== targetEntry.identity.inode) unavailable();
    if (publishingPlan?.planDigest !== witness.value.planDigest) unavailable();
    await session.unlinkExact(witness.value.tempName, tempEntry.identity, true);
    await session.syncDirectory();
    const current = await session.statEntry(targetName);
    if (!current || current.linkCount !== 1 || current.identity.device !== targetEntry.identity.device
      || current.identity.inode !== targetEntry.identity.inode) unavailable();
    const plan = await this.readPlan(revision, session);
    if (plan.planDigest !== witness.value.planDigest) unavailable();
    await this.unlinkWitness(revision, witness.identity, session, true);
  }

  private async readHistoryInSession(session: InstallationPlanJournalStorageSessionV1, signal?: AbortSignal):
  Promise<readonly InstallationPlanV1[]> {
    signal?.throwIfAborted();
    const prefix = `${this.config.installationId}.installation-plan.`;
    const targetPattern = new RegExp(`^${this.config.installationId}\\.installation-plan\\.revision-(\\d{10})\\.json$`);
    const tempPattern = new RegExp(`^${this.config.installationId}\\.installation-plan\\.revision-\\d{10}\\.[0-9a-f-]{36}\\.tmp$`);
    const witnessPattern = new RegExp(`^${this.config.installationId}\\.installation-plan\\.revision-(\\d{10})\\.publish\\.json$`);
    const revisions: number[] = [];
    const witnessed = new Set<number>();
    for (const name of await session.listEntryNames()) {
      signal?.throwIfAborted();
      if (!name.startsWith(prefix)) continue;
      const match = targetPattern.exec(name);
      if (match) revisions.push(Number.parseInt(match[1]!, 10));
      else {
        const witness = witnessPattern.exec(name);
        if (witness) witnessed.add(Number.parseInt(witness[1]!, 10));
        else if (!tempPattern.test(name)) unavailable();
      }
    }
    revisions.sort((left, right) => left - right);
    if (revisions.length > MAX_REVISIONS || revisions.some((value, index) => value !== index)) unavailable();
    for (const revision of witnessed) if (!revisions.includes(revision)) {
      await this.readWitness(revision, session);
      settling();
    }
    const history: InstallationPlanV1[] = [];
    for (const revision of revisions) {
      signal?.throwIfAborted();
      await this.recoverPublishedRevision(revision, session);
      const plan = await this.readPlan(revision, session);
      if (revision === 0) {
        if (plan.revision !== 0 || plan.stages.some(stage => stage.state !== "not_started")) unavailable();
      } else assertLegalHistoryTransition(history[revision - 1]!, plan);
      history.push(plan);
    }
    await session.verifyRoot();
    return Object.freeze(history);
  }

  async readHistory(signal?: AbortSignal): Promise<readonly InstallationPlanV1[]> {
    return this.withSession("read_history", signal, session => this.readSettledHistory(session, signal));
  }

  private async readSettledHistory(session: InstallationPlanJournalStorageSessionV1, signal?: AbortSignal) {
    // Retry only recognizable publication interleavings. Invalid metadata, plan
    // contents and roots still refuse immediately; a crashed writer stays bounded.
    const deadline = performance.now() + 5_000;
    while (true) {
      try { return await this.readHistoryInSession(session, signal); }
      catch (error) {
        if (!(error instanceof PublicationSettling) || performance.now() >= deadline) throw error;
      }
      await delay(2, undefined, signal ? { signal } : undefined);
    }
  }

  /**
   * Read-only inspection for status surfaces. Unlike readHistory(), this never
   * performs publication recovery or cleanup. Any temp, witness, hard-link or
   * otherwise unsettled publication makes the snapshot unavailable so a GET
   * can never mutate the private journal.
   */
  async inspectSettledHistory(signal?: AbortSignal): Promise<readonly InstallationPlanV1[]> {
    return this.withSession("inspect_settled_history", signal, async session => {
    signal?.throwIfAborted();
    const prefix = `${this.config.installationId}.installation-plan.`;
    const targetPattern = new RegExp(`^${this.config.installationId}\\.installation-plan\\.revision-(\\d{10})\\.json$`);
    const tempPattern = new RegExp(`^${this.config.installationId}\\.installation-plan\\.revision-\\d{10}\\.[0-9a-f-]{36}\\.tmp$`);
    const witnessPattern = new RegExp(`^${this.config.installationId}\\.installation-plan\\.revision-\\d{10}\\.publish\\.json$`);
    const revisions: number[] = [];
    for (const name of await session.listEntryNames()) {
      signal?.throwIfAborted();
      if (!name.startsWith(prefix)) continue;
      const match = targetPattern.exec(name);
      if (match) revisions.push(Number.parseInt(match[1]!, 10));
      else if (tempPattern.test(name) || witnessPattern.test(name)) unavailable();
      else unavailable();
    }
    revisions.sort((left, right) => left - right);
    if (revisions.length > MAX_REVISIONS || revisions.some((value, index) => value !== index)) unavailable();
    const history: InstallationPlanV1[] = [];
    for (const revision of revisions) {
      signal?.throwIfAborted();
      const plan = await this.readPlan(revision, session);
      if (revision === 0) {
        if (plan.revision !== 0 || plan.stages.some(stage => stage.state !== "not_started")) unavailable();
      } else assertLegalHistoryTransition(history[revision - 1]!, plan);
      history.push(plan);
    }
    await session.verifyRoot();
    return Object.freeze(history);
    });
  }

  private result(plan: InstallationPlanV1, replayed: boolean): InstallationPlanJournalAppendResultV1 {
    return Object.freeze({ schema: INSTALLATION_PLAN_JOURNAL_V1, installationId: this.config.installationId,
      revision: plan.revision, planDigest: plan.planDigest, replayed,
      enablesAuthority: false, startsService: false, startsWorker: false });
  }

  private async cleanupOwnedTemp(name: string, identity: Identity, session: InstallationPlanJournalStorageSessionV1) {
    await session.unlinkExact(name, identity, true);
  }

  private async readSettledWinner(revision: number, session: InstallationPlanJournalStorageSessionV1,
    signal?: AbortSignal) {
    // A no-replace hard-link publication briefly gives the winner two names.
    // Wait only for that bounded retirement window; a crashed/ambiguous link
    // never becomes accepted merely because another writer observed it.
    // Bound this by elapsed time rather than a retry count. On a loaded CI
    // host a nominal 2 ms timer can be delayed by tens of milliseconds, which
    // previously exhausted 100 retries before the winning writer was scheduled.
    const settleDeadline = performance.now() + 5_000;
    while (performance.now() < settleDeadline) {
      signal?.throwIfAborted();
      try {
        await this.recoverPublishedRevision(revision, session);
        return await this.readPlan(revision, session);
      }
      catch (error) {
        if (!(error instanceof Error) || error.message !== "installation_plan_journal_unavailable") throw error;
      }
      await delay(2, undefined, signal ? { signal } : undefined);
    }
    return unavailable();
  }

  async append(value: unknown, signal?: AbortSignal): Promise<InstallationPlanJournalAppendResultV1> {
    const plan = verifyInstallationPlanV1(value);
    return this.withSession("append", signal, async session => {
    signal?.throwIfAborted();
    const history = await this.readSettledHistory(session, signal);
    const existing = history[plan.revision];
    if (existing) {
      if (!installationPlanReplayMatchesV1(existing, plan)) conflict();
      return this.result(existing, true);
    }
    if (plan.revision !== history.length) conflict();
    if (plan.revision === 0) {
      if (plan.stages.some(stage => stage.state !== "not_started")) conflict();
    } else assertLegalHistoryTransition(history[history.length - 1]!, plan);

    const nonce = randomUUID(), temp = this.tempName(plan.revision, nonce);
    const target = this.targetName(plan.revision);
    let tempIdentity: Identity | undefined;
    let witnessIdentity: Identity | undefined;
    let published = false;
    try {
      tempIdentity = await session.createExclusiveEntry(temp);
      const planBytes = new TextEncoder().encode(`${canonicalJson(plan)}\n`);
      await session.writeExactBounded(temp, tempIdentity, planBytes, MAX_PLAN_BYTES);
      await session.syncFile(temp, tempIdentity);
      signal?.throwIfAborted();
      await session.verifyRoot();
      const witnessValue: PublicationWitness = Object.freeze({ schema: "control-room.installation-plan-publication/v1",
        revision: plan.revision, tempName: this.tempName(plan.revision, nonce), planDigest: plan.planDigest });
      try {
        const witnessName = this.witnessName(plan.revision);
        witnessIdentity = await session.createExclusiveEntry(witnessName);
        const witnessBytes = new TextEncoder().encode(`${canonicalJson(witnessValue)}\n`);
        await session.writeExactBounded(witnessName, witnessIdentity, witnessBytes, 1024);
        await session.syncFile(witnessName, witnessIdentity);
        await session.syncDirectory();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.cleanupOwnedTemp(temp, tempIdentity, session);
        tempIdentity = undefined;
        const winner = await this.readSettledWinner(plan.revision, session, signal);
        if (!installationPlanReplayMatchesV1(winner, plan)) conflict();
        await session.verifyRoot();
        return this.result(winner, true);
      }
      try { await session.linkNoReplace(temp, tempIdentity, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.cleanupOwnedTemp(temp, tempIdentity, session);
        tempIdentity = undefined;
        const winner = await this.readSettledWinner(plan.revision, session, signal);
        if (!installationPlanReplayMatchesV1(winner, plan)) conflict();
        await session.verifyRoot();
        return this.result(winner, true);
      }
      published = true;
      await session.syncDirectory();
      await this.cleanupOwnedTemp(temp, tempIdentity, session);
      tempIdentity = undefined;
      await session.syncDirectory();
      const stored = await this.readPlan(plan.revision, session);
      if (!installationPlanReplayMatchesV1(stored, plan)) conflict();
      if (!witnessIdentity) unavailable();
      await this.unlinkWitness(plan.revision, witnessIdentity, session, true);
      witnessIdentity = undefined;
      await session.verifyRoot();
      return this.result(stored, false);
    } finally {
      if (tempIdentity) await this.cleanupOwnedTemp(temp, tempIdentity, session).catch(unavailable);
      if (witnessIdentity && !published) await this.unlinkWitness(plan.revision, witnessIdentity, session, true).catch(unavailable);
    }
    });
  }
}
