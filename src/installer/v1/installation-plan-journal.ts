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
// A concurrent writer publishes, retires its temp and retires its witness within
// a handful of filesystem round trips. This bounds how long a writer waits for
// that to finish before it treats the journal as genuinely unusable.
const SETTLE_WINDOW_MS = 5_000;
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
// Raised when the filesystem changed between two observations of the same entry,
// which a concurrent writer publishing or retiring can do legitimately. The
// refusal carries the same message as a genuinely unusable journal, but this
// marker lets a caller re-observe within a bounded window instead of refusing a
// journal that is merely still settling. Every genuinely impossible state stays
// terminal and is never retried.
const unavailableWhileSettling = (): never => {
  throw Object.assign(new Error("installation_plan_journal_unavailable"), { journalObservationSettling: true });
};
const observationWasSettling = (error: unknown): boolean =>
  error instanceof Error && (error as { journalObservationSettling?: boolean }).journalObservationSettling === true;
const conflict = (): never => { throw new Error("installation_plan_journal_conflict"); };

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

  private validPrivateFile(entry: InstallationPlanJournalEntryV1, maximumBytes: number, linkCount: number) {
    return entry.kind === "file" && entry.canonical && entry.ownerUid === this.config.ownerUid
      && entry.linkCount === linkCount && (entry.mode & 0o077) === 0
      && entry.size > 0 && entry.size <= maximumBytes;
  }

  // A publication witness is created empty and filled immediately afterwards, so
  // unlike a settled revision it must not be judged on its size alone. Shape is
  // checked here; whether the bytes are there yet is settled by readWitness.
  private validWitnessEntry(entry: InstallationPlanJournalEntryV1) {
    return entry.kind === "file" && entry.canonical && entry.ownerUid === this.config.ownerUid
      && entry.linkCount === 1 && (entry.mode & 0o077) === 0 && entry.size <= 1024;
  }

  private async readPlan(revision: number, session: InstallationPlanJournalStorageSessionV1): Promise<InstallationPlanV1> {
    try {
      const read = await session.readEntry(this.targetName(revision), MAX_PLAN_BYTES);
      if (!this.validPrivateFile(read.entry, MAX_PLAN_BYTES, 1) || read.bytes.byteLength !== read.entry.size) unavailable();
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
    if (!this.validWitnessEntry(before)) {
      // A concurrent writer creates the witness empty (O_CREAT|O_EXCL) and fills
      // it a moment later, so a size-0 witness is a publication still being
      // written rather than a corrupt one. Re-observe; if it is still empty but
      // is the same file, the writer is mid-write, so let the caller re-observe
      // within the bounded settle window rather than refuse a healthy journal.
      const reobserved = await session.statEntry(name);
      if (!reobserved) return undefined;
      if (reobserved.identity.device !== before.identity.device || reobserved.identity.inode !== before.identity.inode) {
        return unavailableWhileSettling();
      }
      if (this.validWitnessEntry(reobserved)) return this.readWitness(revision, session);
      return unavailableWhileSettling();
    }
    try {
      let read: Awaited<ReturnType<InstallationPlanJournalStorageSessionV1["readEntry"]>>;
      try { read = await session.readEntry(name, 1024); }
      catch (error) {
        // A concurrent recoverer can retire this witness between our statEntry
        // and the read, and a live writer can still be filling it in (readEntry
        // refuses an entry that is not yet non-empty). An entry that is gone is a
        // publication that has just settled; an entry that is still there but
        // unreadable is one still being written. Both are a concurrent writer's
        // transient state, so neither may refuse as terminal.
        const reobserved = await session.statEntry(name);
        if (!reobserved) return undefined;
        return unavailableWhileSettling();
      }
      if (read.entry.identity.device !== before.identity.device || read.entry.identity.inode !== before.identity.inode) {
        // The witness we statEntry-ed is not the one we opened, so it was
        // retired and recreated under us while it was being read.
        return unavailableWhileSettling();
      }
      if (!this.validWitnessEntry(read.entry)) unavailable();
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
      // A witness with no target is the live mid-publication window: the witness
      // is made durable before the target is hard-linked.
      if (await this.readWitness(revision, session)) unavailableWhileSettling();
      return;
    }
    const witness = await this.readWitness(revision, session);
    if (targetEntry.linkCount === 1) {
      if (!witness) return;
      const plan = await this.readPlan(revision, session);
      if (plan.planDigest !== witness.value.planDigest) unavailable();
      if (await session.statEntry(witness.value.tempName)) unavailable();
      // Retiring a witness is idempotent: concurrent recoverers all observe the
      // same settled publication and all try to retire its witness, so the first
      // one to unlink wins and the rest must see that as success. allowMissing
      // only tolerates an absent witness; a witness replaced by a different file
      // is still refused, because the identity check is unchanged.
      await this.unlinkWitness(revision, witness.identity, session, true);
      return;
    }
    if (!this.validPrivateFile(targetEntry, MAX_PLAN_BYTES, 2)) unavailable();
    if (!witness) {
      // A two-linked target with no witness is a hard-linked revision this journal
      // never published, and stays terminal. But a concurrent recoverer may have
      // retired the witness (and the temp) since our two-linked statEntry, leaving
      // a fully settled journal that our stale observation would refuse. Re-observe
      // once: accept it only if the target has genuinely settled to a single link.
      const settled = await session.statEntry(targetName);
      if (!settled) return unavailable();
      if (settled.linkCount !== 1 || settled.identity.device !== targetEntry.identity.device
        || settled.identity.inode !== targetEntry.identity.inode) return unavailable();
      await this.readPlan(revision, session);
      return;
    }
    const tempEntry = await session.statEntry(witness.value.tempName);
    if (!tempEntry) {
      // A concurrent recovery, or the original writer, retired the temp between
      // our two observations. That is a publication still settling, not a broken
      // one, so re-observe the target and accept it if it has now settled. A temp
      // that is genuinely absent while the target still carries two links is a
      // publication that cannot complete, so that stays terminal below.
      const settled = await session.statEntry(targetName);
      if (!settled) return unavailableWhileSettling();
      if (settled.linkCount !== 1
        || settled.identity.device !== targetEntry.identity.device
        || settled.identity.inode !== targetEntry.identity.inode) return unavailableWhileSettling();
      const settledPlan = await this.readPlan(revision, session);
      if (settledPlan.planDigest !== witness.value.planDigest) unavailable();
      await this.unlinkWitness(revision, witness.identity, session, true);
      return;
    }
    if (!this.validPrivateFile(tempEntry, MAX_PLAN_BYTES, 2)
      || tempEntry.identity.device !== targetEntry.identity.device
      || tempEntry.identity.inode !== targetEntry.identity.inode) return unavailableWhileSettling();
    await session.unlinkExact(witness.value.tempName, tempEntry.identity, true);
    await session.syncDirectory();
    const current = await session.statEntry(targetName);
    if (!current || current.linkCount !== 1 || current.identity.device !== targetEntry.identity.device
      || current.identity.inode !== targetEntry.identity.inode) unavailable();
    const plan = await this.readPlan(revision, session);
    if (plan.planDigest !== witness.value.planDigest) unavailable();
    await this.unlinkWitness(revision, witness.identity, session, true);
  }

  private async readHistoryInSession(session: InstallationPlanJournalStorageSessionV1, signal?: AbortSignal,
    pendingRevision?: number): Promise<readonly InstallationPlanV1[]> {
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
    if ([...witnessed].some(value => !revisions.includes(value) && value !== pendingRevision)) {
      // A witness with no target is exactly what a live writer holds between
      // making its witness durable and linking its target, so re-observe rather
      // than refuse: a concurrent writer finishes this in a few round trips. A
      // crashed writer never does, and once the bounded window closes
      // whileSettling rethrows this unchanged, so the journal still fails closed.
      unavailableWhileSettling();
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
    // readHistory performs publication recovery, so it contends with a live
    // writer exactly as append does. Re-observe only while a concurrent writer is
    // provably still settling; a genuinely unusable journal is never repaired.
    return this.withSession("read_history", signal, session =>
      this.whileSettling(signal, () => this.readHistoryInSession(session, signal)));
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
    const settleDeadline = performance.now() + SETTLE_WINDOW_MS;
    while (performance.now() < settleDeadline) {
      signal?.throwIfAborted();
      try {
        await this.recoverPublishedRevision(revision, session);
        return await this.readPlan(revision, session);
      }
      catch (error) {
        // Only a state a concurrent writer can still resolve is retried. A
        // terminal refusal (a foreign root, an owned file with the wrong shape, a
        // digest mismatch) propagates immediately and is never waited out.
        if (!observationWasSettling(error)
          && (!(error instanceof Error) || error.message !== "installation_plan_journal_unavailable")) throw error;
      }
      await delay(2, undefined, signal ? { signal } : undefined);
    }
    return unavailable();
  }

  /**
   * Runs one observation, re-running it while a concurrent writer is provably
   * still settling, up to the same bounded window readSettledWinner uses. Every
   * terminal refusal is rethrown on the first attempt, so this never converts a
   * genuinely unusable journal into a success and never repairs one.
   */
  private async whileSettling<T>(signal: AbortSignal | undefined, observe: () => Promise<T>): Promise<T> {
    const settleDeadline = performance.now() + SETTLE_WINDOW_MS;
    while (true) {
      signal?.throwIfAborted();
      try { return await observe(); }
      catch (error) {
        if (!observationWasSettling(error) || performance.now() >= settleDeadline) throw error;
      }
      await delay(2, undefined, signal ? { signal } : undefined);
    }
  }

  async append(value: unknown, signal?: AbortSignal): Promise<InstallationPlanJournalAppendResultV1> {
    const plan = verifyInstallationPlanV1(value);
    return this.withSession("append", signal, async session => {
    signal?.throwIfAborted();
    // The revision this writer is about to publish. Passing it lets the initial
    // read tolerate a concurrent writer's in-flight witness for this same
    // revision instead of refusing a journal that is perfectly healthy. Every
    // other settling state is re-observed until it settles, and every terminal
    // refusal still propagates on the first attempt.
    const history = await this.whileSettling(signal,
      () => this.readHistoryInSession(session, signal, plan.revision));
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
      // Retiring our own witness is a settling step: a concurrent recoverer can
      // unlink and recreate it between the identity check and the unlink, which
      // the exact-identity rule refuses. Re-observe within the bounded window so
      // that a healthy publication is never reported as an unusable journal.
      await this.whileSettling(signal, async () => {
        await this.unlinkWitness(plan.revision, witnessIdentity!, session, true);
      });
      witnessIdentity = undefined;
      await session.verifyRoot();
      return this.result(stored, false);
    } finally {
      // Cleanup failures must not mask the operation's own outcome. A cleanup
      // refusal caused by a concurrent writer is settling, and is swallowed so it
      // cannot turn a successful publication into a terminal refusal; a genuinely
      // unusable root still fails closed on its first observation anyway.
      const discardCleanup = (error: unknown) => {
        if (observationWasSettling(error)) return;
        if (error instanceof Error && error.message === "installation_plan_journal_unavailable") return;
        throw error;
      };
      if (tempIdentity) await this.cleanupOwnedTemp(temp, tempIdentity, session).catch(discardCleanup);
      if (witnessIdentity && !published) {
        await this.unlinkWitness(plan.revision, witnessIdentity, session, true).catch(discardCleanup);
      }
    }
    });
  }
}
