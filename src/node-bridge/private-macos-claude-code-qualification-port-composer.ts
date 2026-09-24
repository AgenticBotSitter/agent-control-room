import { randomUUID } from "node:crypto";
import { isAbsolute, normalize } from "node:path";
import { types } from "node:util";
import { z } from "zod";
import type { OwnedClaudeCodeProcessV1 } from "../harness/claude-code-v1/owned-process-session";
import { CLAUDE_CODE_PRIVATE_INSTALLED_PROCESS_HOST_V1 } from
  "../harness/claude-code-v1/private-installed-process-host";
import { CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1,
  CLAUDE_CODE_TEXT_REVIEW_INVOCATION_POLICY_DIGEST_V1 } from
  "../harness/claude-code-v1/text-review-invocation-policy";
import { qualifyPrivateLocalClaudeTextReviewV1, PRIVATE_LOCAL_CLAUDE_QUALIFICATION_V1,
  type ClaudeTextReviewQualificationReportV1, type PrivateLocalClaudeQualificationPortV1 } from
  "../installer/v1/private-local-claude-qualification";
import { consumePrivateInstalledClaudeProcessReleaseCapabilityV1 } from
  "../installer/v1/private-installed-configuration-custody";
import { sha256Digest } from "../security/canonical-digest";
import { createPrivateMacosClaudeCodeInstalledProcessHostPortsV1 } from
  "./private-macos-claude-code-process-host-ports";

export const PRIVATE_MACOS_CLAUDE_CODE_QUALIFICATION_PORT_COMPOSER_V1 =
  "control-room.private-macos-claude-code-qualification-port-composer/v1" as const;
export const PRIVATE_MACOS_CLAUDE_CODE_QUALIFICATION_ROUTE_CAPABILITY_V1 =
  "control-room.private-macos-claude-code-qualification-route-capability/v1" as const;
export const PRIVATE_MACOS_CLAUDE_CODE_QUALIFICATION_PROCESS_PORT_V1 =
  "control-room.macos-claude-code-qualification-process-port/v1" as const;

const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const releasePattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const digest = z.string().regex(digestPattern);
const path = z.string().min(2).max(4095).refine(value => isAbsolute(value) && normalize(value) === value
  && !/[\u0000-\u001f\u007f]/u.test(value));
const identity = z.object({ device: z.string().regex(/^\d{1,20}$/u), inode: z.string().regex(/^\d{1,20}$/u) }).strict();
const configurationSchema = z.object({
  schema: z.literal(PRIVATE_MACOS_CLAUDE_CODE_QUALIFICATION_PROCESS_PORT_V1),
  helperPath: path, helperSha256: digest,
  executablePath: path, executableSha256: digest, executableIdentity: identity,
  workingDirectory: path, workingDirectoryIdentity: identity,
  workingDirectoryBindingDigest: digest,
  ownerUid: z.number().int().min(1).max(0xffff_ffff),
  holdDeadlineMs: z.number().int().min(100).max(30_000),
  runDeadlineMs: z.number().int().min(100).max(600_000),
  maximumInputBytes: z.number().int().min(1).max(1024 * 1024).default(256 * 1024),
  maximumOutputBytes: z.number().int().min(1).max(8 * 1024 * 1024).default(1024 * 1024),
}).strict();

type ReleaseBinding = Readonly<{ releaseVersion: string; releaseSha256: string; platform: "darwin";
  architecture: "arm64" | "x64"; sidecarManifestSha256: string; archiveSha256: string;
  artifactManifestSha256: string; executableSha256: string }>;
type Configuration = z.output<typeof configurationSchema>;
type QualificationRoute = Readonly<{
  qualify(expectedText: string, signal: AbortSignal, now?: () => number): Promise<ClaudeTextReviewQualificationReportV1>;
}>;

const routes = new WeakMap<object, QualificationRoute>();
const refused = (): never => { const error = new Error("private_macos_claude_code_qualification_port_composer_refused");
  error.stack = undefined; throw error; };

function exact(value: unknown, names: readonly string[]): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value) || types.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) return refused();
  const actual = Object.getOwnPropertyNames(value);
  if (actual.length !== names.length || actual.some(name => !names.includes(name)) || names.some(name => !actual.includes(name))) return refused();
  const result: Record<string, unknown> = {};
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return refused();
    result[name] = descriptor.value;
  }
  return Object.freeze(result);
}

function release(value: unknown): ReleaseBinding {
  const input = exact(value, ["releaseVersion", "releaseSha256", "platform", "architecture", "sidecarManifestSha256",
    "archiveSha256", "artifactManifestSha256", "executableSha256"]);
  if (typeof input.releaseVersion !== "string" || !releasePattern.test(input.releaseVersion)
    || input.platform !== "darwin" || input.architecture !== "arm64" && input.architecture !== "x64") return refused();
  for (const key of ["releaseSha256", "sidecarManifestSha256", "archiveSha256", "artifactManifestSha256", "executableSha256"])
    if (typeof input[key] !== "string" || !digestPattern.test(input[key] as string)) return refused();
  return Object.freeze(input as ReleaseBinding);
}

function verifiedSidecar(value: unknown): ReleaseBinding {
  const input = exact(value, ["schema", "verified", "releaseVersion", "releaseSha256", "platform", "architecture",
    "minimumMacos", "protocol", "sidecarManifestSha256", "archiveSha256", "artifactManifestSha256",
    "executableSha256", "sourceSha256", "toolchain", "files", "compiles", "downloads", "installs"]);
  if (input.schema !== "control-room.macos-claude-code-process-native-sidecar/v1" || input.verified !== true
    || input.minimumMacos !== "13.0" || input.protocol !== "ACRCCP1" || input.compiles !== false
    || input.downloads !== false || input.installs !== false) return refused();
  return release({ releaseVersion: input.releaseVersion, releaseSha256: input.releaseSha256,
    platform: input.platform, architecture: input.architecture, sidecarManifestSha256: input.sidecarManifestSha256,
    archiveSha256: input.archiveSha256, artifactManifestSha256: input.artifactManifestSha256,
    executableSha256: input.executableSha256 });
}

function sameRelease(left: ReleaseBinding, right: ReleaseBinding): boolean {
  return Object.keys(left).every(key => left[key as keyof ReleaseBinding] === right[key as keyof ReleaseBinding]);
}

function qualificationConfiguration(value: unknown): Configuration {
  const input = exact(value, ["schema", "helperPath", "helperSha256", "executablePath", "executableSha256",
    "executableIdentity", "workingDirectory", "workingDirectoryIdentity", "workingDirectoryBindingDigest",
    "ownerUid", "holdDeadlineMs", "runDeadlineMs", "maximumInputBytes", "maximumOutputBytes"]);
  return configurationSchema.parse({ ...input,
    executableIdentity: exact(input.executableIdentity, ["device", "inode"]),
    workingDirectoryIdentity: exact(input.workingDirectoryIdentity, ["device", "inode"]) });
}

function fixedArgs(value: unknown): readonly string[] {
  if (!Array.isArray(value) || types.isProxy(value) || Object.getPrototypeOf(value) !== Array.prototype
    || Object.getOwnPropertySymbols(value).length !== 0
    || Object.getOwnPropertyNames(value).length !== value.length + 1) return refused();
  const captured: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)
      || descriptor.value !== CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1[index]) return refused();
    captured.push(descriptor.value as string);
  }
  if (captured.length !== CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1.length) return refused();
  return Object.freeze(captured);
}

export function createPrivateMacosClaudeCodeSupervisedQualificationRouteDigestV1(
  releaseValue: unknown, configurationValue: unknown): string {
  const selected = release(releaseValue), configuration = qualificationConfiguration(configurationValue);
  return sha256Digest({ schema: "control-room.macos-claude-code-supervised-qualification-route/v1",
    release: selected, helperSha256: configuration.helperSha256,
    executablePath: configuration.executablePath, executableSha256: configuration.executableSha256,
    executableIdentity: configuration.executableIdentity, workingDirectory: configuration.workingDirectory,
    workingDirectoryIdentity: configuration.workingDirectoryIdentity,
    workingDirectoryBindingDigest: configuration.workingDirectoryBindingDigest, ownerUid: configuration.ownerUid,
    fixedInvocationPolicyDigest: CLAUDE_CODE_TEXT_REVIEW_INVOCATION_POLICY_DIGEST_V1 });
}

function qualificationPort(configuration: Configuration, routeDigest: string): PrivateLocalClaudeQualificationPortV1 {
  const { schema: _schema, ...nativeConfiguration } = configuration;
  void _schema;
  const native = createPrivateMacosClaudeCodeInstalledProcessHostPortsV1({
    schema: "control-room.macos-claude-code-process-port/v1", ...nativeConfiguration,
    qualificationDigest: routeDigest,
  });
  let spent = false;
  return Object.freeze({
    launch(request): OwnedClaudeCodeProcessV1 {
      if (spent) return refused();
      spent = true;
      const captured = exact(request, ["schema", "executablePath", "args", "workingDirectory"]);
      fixedArgs(captured.args);
      if (captured.schema !== PRIVATE_LOCAL_CLAUDE_QUALIFICATION_V1
        || captured.executablePath !== configuration.executablePath
        || captured.workingDirectory !== configuration.workingDirectory) return refused();
      const operation = new AbortController();
      let child: ReturnType<typeof native.launch> | undefined;
      const requestBase = Object.freeze({ schema: CLAUDE_CODE_PRIVATE_INSTALLED_PROCESS_HOST_V1,
        executablePath: configuration.executablePath, executableSha256: configuration.executableSha256,
        workingDirectory: configuration.workingDirectory,
        workingDirectoryBindingDigest: configuration.workingDirectoryBindingDigest,
        qualificationDigest: routeDigest });
      const ready = (async () => {
        await native.verifyInstallation({ ...requestBase, signal: operation.signal });
        if (operation.signal.aborted) return refused();
        child = native.launch({ ...requestBase, args: CLAUDE_CODE_TEXT_REVIEW_FIXED_ARGS_V1,
          binding: Object.freeze({ processAttemptId: `qualification-${randomUUID()}`,
            runId: `qualification-${randomUUID()}`, attemptId: `qualification-${randomUUID()}`,
            invocationDigest: CLAUDE_CODE_TEXT_REVIEW_INVOCATION_POLICY_DIGEST_V1 }) });
        return Object.freeze({ writeStdin: child.writeStdin, readStdout: child.readStdout,
          readStderr: child.readStderr, closeStdin: child.closeStdin,
          terminate: child.signalTerminate, exited: child.exited });
      })();
      void ready.catch(() => {});
      return Object.freeze({ ready, async close() {
        operation.abort();
        if (!child) { await ready.catch(() => undefined); return; }
        const controller = new AbortController(), wait = (ms: number) => new Promise<"timeout">(resolve => {
          const timer = setTimeout(() => resolve("timeout"), ms); timer.unref();
        });
        await child.signalTerminate(controller.signal).catch(() => undefined);
        if (await Promise.race([child.exited.then(() => "exit" as const, () => "exit" as const), wait(250)]) === "timeout")
          await child.signalKill(controller.signal).catch(() => undefined);
        await Promise.race([child.exited.catch(() => undefined), wait(5_000)]);
        await child.close(controller.signal).catch(() => undefined);
      } });
    },
  });
}

export function createPrivateMacosClaudeCodeQualificationPortComposerV1(value: unknown) {
  const input = exact(value, ["schema", "manifestReleaseCapability", "verifiedSidecar", "processPortConfiguration"]);
  if (input.schema !== PRIVATE_MACOS_CLAUDE_CODE_QUALIFICATION_PORT_COMPOSER_V1) return refused();
  const protectedIdentity = consumePrivateInstalledClaudeProcessReleaseCapabilityV1(input.manifestReleaseCapability);
  const manifest = release({ releaseVersion: protectedIdentity.releaseVersion, releaseSha256: protectedIdentity.releaseSha256,
    platform: protectedIdentity.platform, architecture: protectedIdentity.architecture,
    sidecarManifestSha256: protectedIdentity.sidecarManifestSha256, archiveSha256: protectedIdentity.archiveSha256,
    artifactManifestSha256: protectedIdentity.artifactManifestSha256, executableSha256: protectedIdentity.executableSha256 });
  const sidecar = verifiedSidecar(input.verifiedSidecar);
  if (!sameRelease(manifest, sidecar)) return refused();
  const configuration = qualificationConfiguration(input.processPortConfiguration);
  if (configuration.helperSha256 !== sidecar.executableSha256) return refused();
  const routeDigest = createPrivateMacosClaudeCodeSupervisedQualificationRouteDigestV1(manifest, configuration);
  const port = qualificationPort(configuration, routeDigest);
  const capability = Object.freeze({ schema: PRIVATE_MACOS_CLAUDE_CODE_QUALIFICATION_ROUTE_CAPABILITY_V1 });
  let qualificationSpent = false;
  routes.set(capability, Object.freeze({
    async qualify(expectedText, signal, now) {
      if (qualificationSpent) return refused();
      qualificationSpent = true;
      const report = await qualifyPrivateLocalClaudeTextReviewV1({ executablePath: configuration.executablePath,
        workingDirectory: configuration.workingDirectory, executableSha256: configuration.executableSha256,
        workingDirectoryBindingDigest: configuration.workingDirectoryBindingDigest,
        expectedText, signal }, port, now);
      return Object.freeze({ ...report, supervisedRouteDigest: routeDigest });
    },
  }));
  return Object.freeze({ schema: PRIVATE_MACOS_CLAUDE_CODE_QUALIFICATION_PORT_COMPOSER_V1,
    status: "protected_qualification_route_bound" as const, capability,
    launchesClaude: false as const, startsTask: false as const, grantsExecutionAuthority: false as const });
}

export function consumePrivateMacosClaudeCodeQualificationRouteV1(value: unknown): QualificationRoute {
  if (!value || typeof value !== "object" || types.isProxy(value)) return refused();
  const route = routes.get(value);
  if (!route || !routes.delete(value)) return refused();
  return route;
}
