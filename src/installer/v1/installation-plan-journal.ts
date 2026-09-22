import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, open, readFile, readdir, realpath, unlink } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalJson } from "../../security/canonical-digest";
import { type InstallationPlanV1, installationPlanReplayMatchesV1,
  verifyInstallationPlanV1 } from "./installation-plan";

const noFollow = constants.O_NOFOLLOW ?? 0;
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
type Identity = Readonly<{ device: bigint; inode: bigint }>;
type PublicationWitness = Readonly<{ schema: "control-room.installation-plan-publication/v1"; revision: number;
  tempName: string; planDigest: string }>;

const unavailable = (): never => { throw new Error("installation_plan_journal_unavailable"); };
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

  constructor(input: unknown) { this.config = capture(input); }

  private targetName(revision: number) {
    return `${this.config.installationId}.installation-plan.revision-${revision.toString().padStart(10, "0")}.json`;
  }

  private targetPath(revision: number) { return join(this.config.rootDirectory, this.targetName(revision)); }

  private tempName(revision: number, nonce: string) {
    return `${this.config.installationId}.installation-plan.revision-${revision.toString().padStart(10, "0")}.${nonce}.tmp`;
  }

  private witnessName(revision: number) {
    return `${this.config.installationId}.installation-plan.revision-${revision.toString().padStart(10, "0")}.publish.json`;
  }

  private witnessPath(revision: number) { return join(this.config.rootDirectory, this.witnessName(revision)); }

  private async assertRoot(): Promise<Identity> {
    try {
      const [entry, canonical] = await Promise.all([lstat(this.config.rootDirectory, { bigint: true }), realpath(this.config.rootDirectory)]);
      if (!entry.isDirectory() || entry.isSymbolicLink() || canonical !== this.config.rootDirectory
        || entry.uid !== BigInt(this.config.ownerUid) || (entry.mode & BigInt(0o077)) !== BigInt(0)) unavailable();
      return Object.freeze({ device: entry.dev, inode: entry.ino });
    } catch { return unavailable(); }
  }

  private async assertSameRoot(identity: Identity) {
    const current = await this.assertRoot();
    if (current.device !== identity.device || current.inode !== identity.inode) unavailable();
  }

  private async syncRoot(identity: Identity) {
    await this.assertSameRoot(identity);
    const handle = await open(this.config.rootDirectory, constants.O_RDONLY | noFollow).catch(unavailable);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isDirectory() || opened.dev !== identity.device || opened.ino !== identity.inode) unavailable();
      await handle.sync();
    } finally { await handle.close().catch(unavailable); }
    await this.assertSameRoot(identity);
  }

  private async readPlan(revision: number, identity: Identity): Promise<InstallationPlanV1> {
    const path = this.targetPath(revision);
    await this.assertSameRoot(identity);
    try {
      const before = await lstat(path, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.uid !== BigInt(this.config.ownerUid)
        || before.nlink !== BigInt(1) || (before.mode & BigInt(0o077)) !== BigInt(0)
        || before.size <= BigInt(0) || before.size > BigInt(MAX_PLAN_BYTES) || await realpath(path) !== path) unavailable();
      const handle = await open(path, constants.O_RDONLY | noFollow);
      try {
        const opened = await handle.stat({ bigint: true });
        if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== BigInt(1)) unavailable();
        const bytes = await handle.readFile({ encoding: "utf8" });
        if (Buffer.byteLength(bytes, "utf8") !== Number(opened.size)) unavailable();
        const plan = verifyInstallationPlanV1(JSON.parse(bytes));
        if (plan.revision !== revision) unavailable();
        return plan;
      } finally { await handle.close().catch(unavailable); }
    } catch (error) {
      if (error instanceof Error && (error.message === "installation_plan_journal_unavailable"
        || error.message === "installation_plan_invalid")) throw error;
      return unavailable();
    }
  }

  private async readWitness(revision: number): Promise<{ value: PublicationWitness; identity: Identity } | undefined> {
    const path = this.witnessPath(revision);
    let before;
    try { before = await lstat(path, { bigint: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; return unavailable(); }
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== BigInt(1)
      || before.uid !== BigInt(this.config.ownerUid) || (before.mode & BigInt(0o077)) !== BigInt(0)
      || before.size <= BigInt(0) || before.size > BigInt(1024) || await realpath(path).catch(unavailable) !== path) unavailable();
    const handle = await open(path, constants.O_RDONLY | noFollow).catch(unavailable);
    try {
      const opened = await handle.stat({ bigint: true });
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== BigInt(1)) unavailable();
      const raw: unknown = JSON.parse(await handle.readFile({ encoding: "utf8" }));
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) unavailable();
      const value = raw as Record<string, unknown>;
      const expectedTempPrefix = `${this.config.installationId}.installation-plan.revision-${revision.toString().padStart(10, "0")}.`;
      if (Object.keys(value).sort().join(",") !== "planDigest,revision,schema,tempName"
        || value.schema !== "control-room.installation-plan-publication/v1" || value.revision !== revision
        || typeof value.tempName !== "string" || !value.tempName.startsWith(expectedTempPrefix)
        || !value.tempName.endsWith(".tmp") || !uuidPattern.test(value.tempName.slice(expectedTempPrefix.length, -4))
        || typeof value.planDigest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value.planDigest)) unavailable();
      return { value: Object.freeze(value as PublicationWitness),
        identity: Object.freeze({ device: opened.dev, inode: opened.ino }) };
    } catch (error) {
      if (error instanceof Error && error.message === "installation_plan_journal_unavailable") throw error;
      return unavailable();
    } finally { await handle.close().catch(unavailable); }
  }

  private async unlinkWitness(revision: number, witnessIdentity: Identity, rootIdentity: Identity, allowMissing = false) {
    const path = this.witnessPath(revision);
    let current;
    try { current = await lstat(path, { bigint: true }); }
    catch (error) {
      if (allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      return unavailable();
    }
    if (!current.isFile() || current.isSymbolicLink() || current.nlink !== BigInt(1)
      || current.uid !== BigInt(this.config.ownerUid) || (current.mode & BigInt(0o077)) !== BigInt(0)
      || current.dev !== witnessIdentity.device || current.ino !== witnessIdentity.inode) unavailable();
    await this.assertSameRoot(rootIdentity);
    try { await unlink(path); }
    catch (error) {
      if (!(allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT")) return unavailable();
    }
    await this.syncRoot(rootIdentity);
  }

  private async recoverPublishedRevision(revision: number, identity: Identity) {
    const target = this.targetPath(revision);
    let targetEntry;
    try { targetEntry = await lstat(target, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return unavailable();
      if (await this.readWitness(revision)) unavailable();
      return;
    }
    const witness = await this.readWitness(revision);
    if (targetEntry.nlink === BigInt(1)) {
      if (!witness) return;
      const plan = await this.readPlan(revision, identity);
      if (plan.planDigest !== witness.value.planDigest) unavailable();
      const temp = join(this.config.rootDirectory, witness.value.tempName);
      try { await lstat(temp); return unavailable(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return unavailable(); }
      await this.unlinkWitness(revision, witness.identity, identity);
      return;
    }
    if (!targetEntry.isFile() || targetEntry.isSymbolicLink() || targetEntry.nlink !== BigInt(2)
      || targetEntry.uid !== BigInt(this.config.ownerUid) || (targetEntry.mode & BigInt(0o077)) !== BigInt(0)
      || await realpath(target).catch(unavailable) !== target) unavailable();
    if (!witness) return unavailable();
    const temp = join(this.config.rootDirectory, witness.value.tempName);
    const tempEntry = await lstat(temp, { bigint: true }).catch(unavailable);
    if (!tempEntry.isFile() || tempEntry.isSymbolicLink() || tempEntry.nlink !== BigInt(2)
      || tempEntry.uid !== BigInt(this.config.ownerUid) || (tempEntry.mode & BigInt(0o077)) !== BigInt(0)
      || tempEntry.dev !== targetEntry.dev || tempEntry.ino !== targetEntry.ino
      || await realpath(temp).catch(unavailable) !== temp) unavailable();
    await this.assertSameRoot(identity);
    try { await unlink(temp); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return unavailable();
      const current = await lstat(target, { bigint: true }).catch(unavailable);
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== BigInt(1)
        || current.dev !== targetEntry.dev || current.ino !== targetEntry.ino) unavailable();
    }
    await this.syncRoot(identity);
    const plan = await this.readPlan(revision, identity);
    if (plan.planDigest !== witness.value.planDigest) unavailable();
    await this.unlinkWitness(revision, witness.identity, identity, true);
  }

  async readHistory(signal?: AbortSignal): Promise<readonly InstallationPlanV1[]> {
    signal?.throwIfAborted();
    const root = await this.assertRoot();
    const prefix = `${this.config.installationId}.installation-plan.`;
    const targetPattern = new RegExp(`^${this.config.installationId}\\.installation-plan\\.revision-(\\d{10})\\.json$`);
    const tempPattern = new RegExp(`^${this.config.installationId}\\.installation-plan\\.revision-\\d{10}\\.[0-9a-f-]{36}\\.tmp$`);
    const witnessPattern = new RegExp(`^${this.config.installationId}\\.installation-plan\\.revision-(\\d{10})\\.publish\\.json$`);
    const revisions: number[] = [];
    const witnessed = new Set<number>();
    for (const name of await readdir(this.config.rootDirectory)) {
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
    if ([...witnessed].some(value => !revisions.includes(value))) unavailable();
    const history: InstallationPlanV1[] = [];
    for (const revision of revisions) {
      signal?.throwIfAborted();
      await this.recoverPublishedRevision(revision, root);
      const plan = await this.readPlan(revision, root);
      if (revision === 0) {
        if (plan.revision !== 0 || plan.stages.some(stage => stage.state !== "not_started")) unavailable();
      } else assertLegalHistoryTransition(history[revision - 1]!, plan);
      history.push(plan);
    }
    await this.assertSameRoot(root);
    return Object.freeze(history);
  }

  /**
   * Read-only inspection for status surfaces. Unlike readHistory(), this never
   * performs publication recovery or cleanup. Any temp, witness, hard-link or
   * otherwise unsettled publication makes the snapshot unavailable so a GET
   * can never mutate the private journal.
   */
  async inspectSettledHistory(signal?: AbortSignal): Promise<readonly InstallationPlanV1[]> {
    signal?.throwIfAborted();
    const root = await this.assertRoot();
    const prefix = `${this.config.installationId}.installation-plan.`;
    const targetPattern = new RegExp(`^${this.config.installationId}\\.installation-plan\\.revision-(\\d{10})\\.json$`);
    const tempPattern = new RegExp(`^${this.config.installationId}\\.installation-plan\\.revision-\\d{10}\\.[0-9a-f-]{36}\\.tmp$`);
    const witnessPattern = new RegExp(`^${this.config.installationId}\\.installation-plan\\.revision-\\d{10}\\.publish\\.json$`);
    const revisions: number[] = [];
    for (const name of await readdir(this.config.rootDirectory)) {
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
      const plan = await this.readPlan(revision, root);
      if (revision === 0) {
        if (plan.revision !== 0 || plan.stages.some(stage => stage.state !== "not_started")) unavailable();
      } else assertLegalHistoryTransition(history[revision - 1]!, plan);
      history.push(plan);
    }
    await this.assertSameRoot(root);
    return Object.freeze(history);
  }

  private result(plan: InstallationPlanV1, replayed: boolean): InstallationPlanJournalAppendResultV1 {
    return Object.freeze({ schema: INSTALLATION_PLAN_JOURNAL_V1, installationId: this.config.installationId,
      revision: plan.revision, planDigest: plan.planDigest, replayed,
      enablesAuthority: false, startsService: false, startsWorker: false });
  }

  private async cleanupOwnedTemp(path: string, identity: Identity) {
    try {
      const current = await lstat(path, { bigint: true });
      if (!current.isFile() || current.isSymbolicLink() || current.uid !== BigInt(this.config.ownerUid)
        || (current.mode & BigInt(0o077)) !== BigInt(0)
        || current.dev !== identity.device || current.ino !== identity.inode) unavailable();
      await unlink(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async readSettledWinner(revision: number, identity: Identity, signal?: AbortSignal) {
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
        await this.recoverPublishedRevision(revision, identity);
        return await this.readPlan(revision, identity);
      }
      catch (error) {
        if (!(error instanceof Error) || error.message !== "installation_plan_journal_unavailable") throw error;
      }
      await delay(2, undefined, signal ? { signal } : undefined);
    }
    return unavailable();
  }

  async append(value: unknown, signal?: AbortSignal): Promise<InstallationPlanJournalAppendResultV1> {
    signal?.throwIfAborted();
    const plan = verifyInstallationPlanV1(value), root = await this.assertRoot();
    const history = await this.readHistory(signal);
    const existing = history[plan.revision];
    if (existing) {
      if (!installationPlanReplayMatchesV1(existing, plan)) conflict();
      return this.result(existing, true);
    }
    if (plan.revision !== history.length) conflict();
    if (plan.revision === 0) {
      if (plan.stages.some(stage => stage.state !== "not_started")) conflict();
    } else assertLegalHistoryTransition(history[history.length - 1]!, plan);

    const nonce = randomUUID(), temp = join(this.config.rootDirectory, this.tempName(plan.revision, nonce));
    const target = this.targetPath(plan.revision);
    let tempIdentity: Identity | undefined;
    let witnessIdentity: Identity | undefined;
    let published = false;
    try {
      const handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
      try {
        const opened = await handle.stat({ bigint: true });
        if (!opened.isFile() || opened.uid !== BigInt(this.config.ownerUid) || opened.nlink !== BigInt(1)
          || (opened.mode & BigInt(0o077)) !== BigInt(0)) unavailable();
        tempIdentity = Object.freeze({ device: opened.dev, inode: opened.ino });
        await handle.writeFile(`${canonicalJson(plan)}\n`, "utf8");
        await handle.sync();
      } finally { await handle.close().catch(unavailable); }
      signal?.throwIfAborted();
      await this.assertSameRoot(root);
      const witnessValue: PublicationWitness = Object.freeze({ schema: "control-room.installation-plan-publication/v1",
        revision: plan.revision, tempName: this.tempName(plan.revision, nonce), planDigest: plan.planDigest });
      try {
        const witness = await open(this.witnessPath(plan.revision),
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noFollow, 0o600);
        try {
          const opened = await witness.stat({ bigint: true });
          if (!opened.isFile() || opened.uid !== BigInt(this.config.ownerUid) || opened.nlink !== BigInt(1)
            || (opened.mode & BigInt(0o077)) !== BigInt(0)) unavailable();
          witnessIdentity = Object.freeze({ device: opened.dev, inode: opened.ino });
          await witness.writeFile(`${canonicalJson(witnessValue)}\n`, "utf8");
          await witness.sync();
        } finally { await witness.close().catch(unavailable); }
        await this.syncRoot(root);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.cleanupOwnedTemp(temp, tempIdentity);
        tempIdentity = undefined;
        const winner = await this.readSettledWinner(plan.revision, root, signal);
        if (!installationPlanReplayMatchesV1(winner, plan)) conflict();
        return this.result(winner, true);
      }
      try { await link(temp, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        await this.cleanupOwnedTemp(temp, tempIdentity);
        tempIdentity = undefined;
        const winner = await this.readSettledWinner(plan.revision, root, signal);
        if (!installationPlanReplayMatchesV1(winner, plan)) conflict();
        return this.result(winner, true);
      }
      published = true;
      await this.syncRoot(root);
      await this.cleanupOwnedTemp(temp, tempIdentity);
      tempIdentity = undefined;
      await this.syncRoot(root);
      const stored = await this.readPlan(plan.revision, root);
      if (!installationPlanReplayMatchesV1(stored, plan)) conflict();
      if (!witnessIdentity) unavailable();
      await this.unlinkWitness(plan.revision, witnessIdentity, root, true);
      witnessIdentity = undefined;
      return this.result(stored, false);
    } finally {
      if (tempIdentity) await this.cleanupOwnedTemp(temp, tempIdentity).catch(unavailable);
      if (witnessIdentity && !published) await this.unlinkWitness(plan.revision, witnessIdentity, root).catch(unavailable);
    }
  }
}
