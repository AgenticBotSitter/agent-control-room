import { createPrivatePostgresDatabase, validatePrivatePostgresConfiguration, type PrivatePostgresConfiguration } from "./private-postgres";
import { validatePrivateStartupConfiguration, type PrivateStartupConfiguration } from "./private-startup";
import { verifyPrivateDatabase, verifyIdeaCreationDatabase } from "./private-database-preflight";
import { installPrivateWebProcess } from "./private-process";
import { captureIdeaParticipants, IdeaSessionCreationService, type IdeaCreateOperation } from "./idea-create-operation";
import { WebIdeaSynthesisOperation } from "./idea-synthesis-operation";
import { WebIdeaDecisionOperation } from "./idea-decision-operation";

export type PrivateIdeaAuthoringConfiguration = { web: PrivateStartupConfiguration;
  ideaAuthoring: { database: PrivatePostgresConfiguration; participants: unknown[] } };

/** Pure, non-executing composition. Existing web and writer roles stay separate. */
export function validatePrivateIdeaAuthoringConfiguration(input: PrivateIdeaAuthoringConfiguration) {
  try {
    if (Object.keys(input).sort().join(",") !== "ideaAuthoring,web"
      || Object.keys(input.ideaAuthoring).sort().join(",") !== "database,participants") throw new Error();
    const web = validatePrivateStartupConfiguration(input.web);
    const database = validatePrivatePostgresConfiguration(input.ideaAuthoring.database);
    if (!web.ideaProjects || database.host !== web.database.host || database.port !== web.database.port
      || database.database !== web.database.database || database.username === web.database.username) throw new Error();
    return { web, ideaAuthoring: { database, participants: captureIdeaParticipants(input.ideaAuthoring.participants) } };
  } catch { throw new Error("private_idea_authoring_config_invalid"); }
}

/** Reuses private-process request admission/drain and bounded production pools.
 * No planner, runtime, queue or provider port exists in this configuration. */
export function createPrivateIdeaAuthoringBootstrap(dependencies: {
  openDatabase: typeof createPrivatePostgresDatabase;
  install: typeof installPrivateWebProcess; clock?: () => number;
}) {
  let started = false;
  return Object.freeze({ async start(input: PrivateIdeaAuthoringConfiguration, signal?: AbortSignal) {
    if (started) throw new Error("private_idea_authoring_already_attempted");
    started = true;
    const config = validatePrivateIdeaAuthoringConfiguration(input), clock = dependencies.clock ?? Date.now;
    const active = () => { if (signal?.aborted) throw new Error("private_idea_authoring_canceled"); };
    active();
    const pools: ReturnType<typeof createPrivatePostgresDatabase>[] = [];
    let closed: Promise<void> | undefined;
    const close = () => closed ??= (async () => {
      // One resource is closed once; distinct acquired handles retain their own
      // cleanup obligations even when an invalid factory aliases their clients.
      const owned = [...new Set(pools)];
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const outcomes = await Promise.race([Promise.allSettled(owned.map(pool => Promise.resolve().then(() => pool.close()))),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error()), 5000); })]);
        if (outcomes.some(result => result.status === "rejected")) throw new Error();
      } catch { throw new Error("private_idea_authoring_cleanup_uncertain"); }
      finally { clearTimeout(timer); }
    })();
    try {
      const now = clock(); if (!Number.isSafeInteger(now) || now < 0) throw new Error();
      const web = dependencies.openDatabase(config.web.database); pools.push(web);
      active(); await verifyPrivateDatabase(web.client, config.web.database, config.web, now); active();
      const writer = dependencies.openDatabase(config.ideaAuthoring.database); pools.push(writer);
      if (web === writer || web.client === writer.client) throw new Error();
      active(); await verifyIdeaCreationDatabase(writer.client, config.ideaAuthoring.database, config.web, now); active();
      const scope = { tenantId: config.web.tenantId, workspaceId: config.web.workspaceId }, key = config.web.ideaProjects!.integrityKey;
      const creation = new IdeaSessionCreationService(writer.client, scope, key, config.ideaAuthoring.participants, clock);
      const synthesis = new WebIdeaSynthesisOperation(writer.client, scope, key, clock);
      const decision = new WebIdeaDecisionOperation(writer.client, scope, key, clock);
      const ideaCreation: IdeaCreateOperation = Object.freeze({ ...scope, options: creation.options.bind(creation),
        create: creation.create.bind(creation), synthesize: synthesis.synthesize.bind(synthesis), decide: decision.decide.bind(decision) });
      const installed = dependencies.install({ ...config.web, clock, ideaCreation,
        database: { client: web.client, close } });
      let stopping = false, closing: Promise<void> | undefined;
      return Object.freeze({ isReady: () => !stopping && !closed && web.isAvailable() && writer.isAvailable(),
        close: () => { stopping = true; return closing ??= installed.close(); } });
    } catch {
      await close();
      throw new Error("private_idea_authoring_prerequisites_failed");
    }
  } });
}

const production = createPrivateIdeaAuthoringBootstrap({ openDatabase: createPrivatePostgresDatabase, install: installPrivateWebProcess });
export const startPrivateIdeaAuthoringApplication = production.start;
