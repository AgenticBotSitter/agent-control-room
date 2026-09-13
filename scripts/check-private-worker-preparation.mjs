import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';
import { normalizeStaticDiscovery } from '../src/node-fleet/v1/static-discovery.ts';
import { evaluateFleetEligibility } from '../src/node-fleet/v1/eligibility.ts';
import { connectorOperationAdmissibleV1, connectorOperationNamesV1,
  parseConnectorProfileV1 } from '../src/harness/v1/connector-profile.ts';
import { sha256Digest } from '../src/security/canonical-digest.ts';

const id = z.string().min(1).max(180).regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/);
const label = z.string().min(1).max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9._: +\-]*$/);
const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const instant = z.string().datetime({ offset: true });
const inventory = z.object({ kind: z.enum(['bridge', 'harness', 'executor', 'tool']),
  id, version: label, manifestDigest: digest }).strict();
const expectedComponent = z.object({ kind: z.enum(['bridge', 'harness', 'executor']),
  id, version: label, manifestDigest: digest }).strict();
const metric = z.object({ quality: z.enum(['observed', 'estimated', 'blocked', 'unavailable']),
  value: z.number().nonnegative().optional() }).strict();
const inputSchema = z.object({
  schema: z.literal('control-room.private-worker-preparation-input/v1'),
  selectedProfile: z.unknown(),
  expected: z.object({ tenantId: id, nodeId: id, endpointDigest: digest,
    connectorProfileDigest: digest, platform: z.enum(['macos', 'linux']), architecture: label,
    components: z.array(expectedComponent).length(3), requiredScratchBytes: z.number().int().nonnegative(),
    requiredCapabilityProbeId: id.optional(), requireVerifiedCapability: z.boolean(),
  }).strict(),
  facts: z.object({ tenantId: id, nodeId: id, endpointDigest: digest,
    platform: z.enum(['macos', 'linux']), architecture: label,
    cpuLogicalCores: z.number().int().min(1), memoryBytes: z.number().int().nonnegative(),
    gpuClasses: z.array(label).max(32), storage: z.array(z.object({ capacityBytes: z.number().int().nonnegative(),
      availableBytes: z.number().int().nonnegative(), scratchEligible: z.boolean(),
      encryptionReported: z.boolean() }).strict()).min(1),
    networkClass: z.enum(['offline', 'limited', 'metered', 'unmetered']),
    inventory: z.array(inventory).max(512), executorManifestDigest: digest,
    observedAt: instant, expiresAt: instant, evaluatedAt: instant,
    telemetry: z.object({ observedAt: instant, expiresAt: instant,
      availableStorageBytes: metric, trust: z.enum(['reported', 'verified', 'blocked', 'unavailable']) }).strict(),
    capabilities: z.array(z.object({ probeId: id, probeVersion: label, outcome: z.enum(['pass', 'fail', 'blocked', 'unavailable']),
      reasonCode: id, observedAt: instant, expiresAt: instant,
      trust: z.enum(['reported', 'verified', 'blocked', 'unavailable']), evidenceDigest: digest.optional() }).strict()).max(32),
  }).strict(),
  requestedOperations: z.array(z.enum(connectorOperationNamesV1)).max(connectorOperationNamesV1.length),
}).strict();

const unavailable = () => { throw new Error('private_worker_preparation_unavailable'); };

/**
 * Checks only supplied, already-observed facts. It never starts a harness, reads a
 * credential, discovers an endpoint, installs software or changes host state.
 */
export function checkPrivateWorkerPreparationV1(value) {
  try {
    const input = inputSchema.parse(structuredClone(value));
    const profile = parseConnectorProfileV1(input.selectedProfile);
    if (input.expected.connectorProfileDigest !== sha256Digest(profile)
      || input.facts.tenantId !== input.expected.tenantId || input.facts.nodeId !== input.expected.nodeId
      || input.facts.endpointDigest !== input.expected.endpointDigest
      || input.facts.platform !== input.expected.platform || input.facts.architecture !== input.expected.architecture
      || new Set(input.expected.components.map(component => component.kind)).size !== 3) unavailable();
    const normalized = normalizeStaticDiscovery({ platform: input.facts.platform,
      architecture: input.facts.architecture, cpuLogicalCores: input.facts.cpuLogicalCores,
      memoryBytes: input.facts.memoryBytes, gpuClasses: input.facts.gpuClasses,
      storage: input.facts.storage, networkClass: input.facts.networkClass,
      inventory: input.facts.inventory, executorManifestDigest: input.facts.executorManifestDigest });
    const actual = new Map(normalized.payload.inventory.map(component => [component.kind, component]));
    for (const expected of input.expected.components) {
      if (normalized.payload.inventory.filter(component => component.kind === expected.kind).length !== 1) unavailable();
      const found = actual.get(expected.kind);
      if (!found || found.id !== expected.id || found.version !== expected.version
        || found.manifestDigest !== expected.manifestDigest) unavailable();
    }
    const harness = actual.get('harness');
    if (!harness || harness.id !== profile.connectorId || harness.version !== profile.harnessVersion) unavailable();
    const selectedSourceDigest = sha256Digest(profile.sourcePackage
      ? { ecosystem: profile.sourcePackage.ecosystem, name: profile.sourcePackage.name,
        version: profile.sourcePackage.version, integrity: profile.sourcePackage.integrity }
      : { ecosystem: 'git', revision: profile.sourceRevision });
    if (harness.manifestDigest !== selectedSourceDigest) unavailable();
    if (input.facts.executorManifestDigest !== actual.get('executor')?.manifestDigest) unavailable();
    const discovery = { schemaVersion: '1.0.0', tenantId: input.facts.tenantId, nodeId: input.facts.nodeId,
      sequence: 1, observedAt: input.facts.observedAt, expiresAt: input.facts.expiresAt,
      trust: 'reported', fingerprint: normalized.fingerprint, kind: 'discovery', source: 'static_collector',
      payload: normalized.payload };
    const telemetry = { schemaVersion: '1.0.0', tenantId: input.facts.tenantId, nodeId: input.facts.nodeId,
      sequence: 2, observedAt: input.facts.telemetry.observedAt, expiresAt: input.facts.telemetry.expiresAt,
      trust: input.facts.telemetry.trust, fingerprint: sha256Digest(input.facts.telemetry), kind: 'telemetry',
      source: 'telemetry_port', payload: { samplingIntervalSeconds: 60,
        cpuUtilizationPercent: { quality: 'unavailable' }, availableMemoryBytes: { quality: 'unavailable' },
        availableStorageBytes: input.facts.telemetry.availableStorageBytes,
        networkClass: 'unavailable', powerState: 'unknown', thermalState: 'unknown' } };
    const capabilities = input.facts.capabilities.map((capability, index) => ({ schemaVersion: '1.0.0',
      tenantId: input.facts.tenantId, nodeId: input.facts.nodeId, sequence: index + 3,
      observedAt: capability.observedAt, expiresAt: capability.expiresAt, trust: capability.trust,
      fingerprint: sha256Digest(capability), kind: 'capability', source: 'probe_runner',
      payload: { probeId: capability.probeId, probeVersion: capability.probeVersion,
        outcome: capability.outcome, reasonCode: capability.reasonCode,
        ...(capability.evidenceDigest ? { evidenceDigest: capability.evidenceDigest } : {}) } }));
    const fleet = evaluateFleetEligibility({ now: input.facts.evaluatedAt,
      signals: [discovery, telemetry, ...capabilities], requiredScratchBytes: input.expected.requiredScratchBytes,
      requiredCapabilityProbeId: input.expected.requiredCapabilityProbeId,
      requireVerifiedCapability: input.expected.requireVerifiedCapability });
    const reasons = [...fleet.reasons];
    const observed = Date.parse(input.facts.observedAt), expires = Date.parse(input.facts.expiresAt);
    const evaluated = Date.parse(input.facts.evaluatedAt);
    if (expires <= observed || evaluated < observed || evaluated >= expires) reasons.push('static_discovery_stale');
    const operations = Object.fromEntries(input.requestedOperations.map(name =>
      [name, connectorOperationAdmissibleV1(profile, name) ? 'available' : 'unavailable']));
    const ready = reasons.length === 0 && Object.values(operations).every(state => state === 'available');
    return Object.freeze({ schema: 'control-room.private-worker-preparation-result/v1',
      ready, platform: input.facts.platform, architecture: input.facts.architecture,
      tenantId: input.facts.tenantId, nodeId: input.facts.nodeId,
      connectorProfileDigest: input.expected.connectorProfileDigest,
      discoveryFingerprint: normalized.fingerprint, operations: Object.freeze(operations),
      eligibility: Object.freeze({ eligible: reasons.length === 0, reasons: Object.freeze(reasons) }),
      usage: 'unknown', startsHarness: false, grantsExecutionAuthority: false });
  } catch { return unavailable(); }
}

async function main(args) {
  if (args.length !== 2 || args[0] !== '--input') unavailable();
  const value = JSON.parse(await readFile(resolve(args[1]), 'utf8'));
  process.stdout.write(`${JSON.stringify(checkPrivateWorkerPreparationV1(value))}\n`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await main(process.argv.slice(2)); }
  catch { console.error('Control Room worker preparation refused supplied facts.'); process.exitCode = 1; }
}
