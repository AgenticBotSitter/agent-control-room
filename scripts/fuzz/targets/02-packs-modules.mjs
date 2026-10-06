// Project packs (owner paste/file), module manifests and module bundles (owner upload).
import { generateKeyPairSync } from "node:crypto";
import { parseProjectPackV1 } from "../../../src/project-packs/v1/project-pack.ts";
import { parseProjectPackV2 } from "../../../src/project-packs/v2/project-pack.ts";
import { browseProjectPackV1 } from "../../../src/project-packs/v1/browse-preview.ts";
import { parseModuleManifestV1 } from "../../../src/modules/v1/manifest.ts";
import { canonicalModuleBundleV1, verifyModuleBundleV1, signModuleBundleV1, moduleKeyIdV1 } from "../../../src/modules/v1/bundle.ts";
import { sha256Digest } from "../../../src/security/canonical-digest.ts";
import { PRODUCT_CONFIGURATION_MODULES_V1 } from "../../../src/config/v1/product-configuration.ts";

const PRINTABLE = /^[^\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]*$/u;
const packV1 = () => ({ schema: "control-room.project-pack/v1", title: "Research desk", summary: "Collect and summarise articles.",
  optionalModules: [...PRODUCT_CONFIGURATION_MODULES_V1].slice(0, 2), setupGuidance: ["Add a source.", "Pick a cadence."], attribution: "Owner", license: "Apache-2.0" });
const packV2 = () => ({ schema: "control-room.project-pack/v2", title: "Research desk", summary: "Collect and summarise articles.",
  modules: [{ id: "acme.news", version: "1.2.3" }, { id: "zeta.tools", version: "0.1.0-beta.1" }], setupGuidance: ["Add a source."], license: "MIT" });
const skill = { id: "summarise", version: 1, name: "Summarise", instructions: "Summarise the article in three lines." };
const manifest = () => ({ schema: "control-room.module-manifest/v1", id: "acme.news", version: "1.2.3", name: "Acme News", publisher: "Acme",
  license: "MIT", controlRoomCompatibility: ">=0.1.0 <2.0.0", class: "declarative",
  skills: [{ ...skill, contentDigest: sha256Digest({ schema: "control-room.module-shared-skill/v1", ...skill }) }],
  permissions: { projectData: [{ resource: "articles", access: ["read"] }], taskTemplates: ["summarise"], pipelineTemplates: [], workerCapabilities: [],
    notifications: { slots: ["digest"], maxPerHour: 2 }, attention: { slots: [], maxOpenPerProject: 0 },
    scheduledJobs: { jobs: ["nightly"], maxConcurrent: 1, maxRunsPerDay: 1, maxRuntimeSeconds: 60 } },
  ui: { projectTabs: [{ id: "news", label: "News" }], needsYou: false,
    settings: { type: "object", properties: { cadence: { type: "integer", title: "Cadence", default: 2, minimum: 1, maximum: 24 } }, required: ["cadence"], additionalProperties: false } },
  events: { subscribe: ["article.added"], emitNotifications: true } });
const codeManifest = () => ({ ...manifest(), id: "acme.tools", class: "code", skills: undefined,
  data: { schemaNamespace: "module_acme_tools", tenantScoped: true, projectScoped: true, migrations: [{ version: "1.0.0", upFile: "migrations/up.sql", downFile: "migrations/down.sql" }] } });
const b64 = text => Buffer.from(text, "utf8").toString("base64");
const bundle = (files = [{ path: "prompts/intro.md", contentBase64: b64("# Intro\n\nSummarise the [article](https://example.invalid).\n") },
  { path: "config/settings.json", contentBase64: b64('{"cadence":2,"name":"ok"}') }, { path: "notes.txt", contentBase64: b64("plain text\n") }]) =>
  ({ schema: "control-room.module-bundle/v1", manifest: manifest(), files });
const keys = generateKeyPairSync("ed25519");
const spki = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
const trust = { trustedKeys: [{ keyId: moduleKeyIdV1(spki), publicKeySpki: spki, label: "Acme publisher", moduleIds: ["*"] }], reviewedBundleDigests: [] };
const options = { trust, hostVersion: "1.4.0" };

function markdownBomb(rng, big = true) {
  if (!big) { const parts = ["[", "]", "(", ")", "*", "_", "`", "|", "-", ">", "#", "!", "\\", " ", "\n", "a", "[a]: ", "<", "&amp;", "~~"]; let s = ""; const n = rng.int(10, 1500); for (let i = 0; i < n; i++) s += rng.pick(parts); return s; }
  const parts = ["[", "]", "(", ")", "*", "_", "`", "|", "-", ">", "#", "!", "\\", " ", "\n", "a", "[a]: ", "<", "&amp;", "~~", "- [ ] ", "1. "];
  const kind = rng.int(0, 7);
  if (kind === 0) return "[".repeat(rng.int(100, 20000));
  if (kind === 1) return ("[a" + "]".repeat(rng.int(1, 3)) + "(").repeat(rng.int(50, 5000));
  if (kind === 2) return "*".repeat(rng.int(100, 20000)) + "a";
  if (kind === 3) return "| a |\n|---|\n" + "| ".repeat(rng.int(100, 20000));
  if (kind === 4) return "[a]: x\n".repeat(rng.int(100, 20000)) + "[a]".repeat(rng.int(100, 5000));
  if (kind === 5) return ("- ".repeat(rng.int(1, 60)) + "x\n").repeat(rng.int(10, 2000));
  if (kind === 6) return "<".repeat(rng.int(1000, 9999)) + " a";
  let s = ""; const n = rng.int(100, 20000); for (let i = 0; i < n; i++) s += rng.pick(parts); return s;
}

const expected = error => error instanceof Error && (/^(project_pack_|module_)/u.test(error.message) || /ZodError/u.test(error.name) || error.name === "$ZodError");

function checkTextInvariant(value, path = "") {
  if (typeof value === "string") { if (!PRINTABLE.test(value)) return `accepted non-printable text at ${path}`; return undefined; }
  if (Array.isArray(value)) { for (let i = 0; i < value.length; i++) { const v = checkTextInvariant(value[i], `${path}[${i}]`); if (v) return v; } return undefined; }
  if (value && typeof value === "object") { for (const [k, v] of Object.entries(value)) { if (["__proto__", "constructor", "prototype"].includes(k)) return `accepted prototype key ${k}`; const r = checkTextInvariant(v, `${path}.${k}`); if (r) return r; } }
  return undefined;
}

export const targets = [
  {
    name: "project-pack-v1",
    corpus: [packV1()],
    generate(rng, corpus) {
      const r = rng.float();
      if (r < 0.6) return { $label: "mutate", $input: rng.mutate(corpus[0], rng.int(1, 4)) };
      if (r < 0.8) return { $label: "raw-text", $input: { rawText: rng.mutateText(JSON.stringify(corpus[0]), rng.int(1, 3)) } };
      if (r < 0.9) return { $label: "random", $input: rng.jsonValue(0, 5) };
      return { $label: "oversize", $input: { ...corpus[0], summary: "s".repeat(rng.int(1900, 70000)) } };
    },
    invoke(input) {
      if (input && typeof input === "object" && "rawText" in input && Object.keys(input).length === 1) {
        const outcome = browseProjectPackV1(input, { ideaLab: true, news: false, sessionObservations: true });
        if (outcome.status === "refused") { if (!/^project_pack_/u.test(outcome.reason)) throw new Error(`browse_opaque_reason:${outcome.reason}`); return { outcome: "refused", value: outcome.reason }; }
        return { outcome: "accepted", value: outcome.pack };
      }
      return { outcome: "accepted", value: parseProjectPackV1(input) };
    },
    expectedErrors: expected,
    oracle(input, result) {
      if (result.outcome !== "accepted") return undefined;
      const pack = result.value;
      if (pack.schema !== "control-room.project-pack/v1") return "accepted wrong schema";
      if (typeof pack.title !== "string" || pack.title.length < 1 || pack.title.length > 120) return "accepted out-of-bounds title";
      if (pack.summary.length > 2000 || pack.setupGuidance.length > 10) return "accepted out-of-bounds summary/guidance";
      if (new Set(pack.optionalModules).size !== pack.optionalModules.length) return "accepted duplicate modules";
      if (!Object.isFrozen(pack)) return "accepted pack is not frozen";
      return checkTextInvariant(pack);
    },
  },
  {
    name: "project-pack-v2",
    corpus: [packV2()],
    generate(rng, corpus) {
      const r = rng.float();
      if (r < 0.75) return { $label: "mutate", $input: rng.mutate(corpus[0], rng.int(1, 4)) };
      if (r < 0.9) return { $label: "random", $input: rng.jsonValue(0, 5) };
      return { $label: "many-modules", $input: { ...corpus[0], modules: Array.from({ length: rng.int(50, 400) }, (_, i) => ({ id: `m${String(i).padStart(3, "0")}.x`, version: "1.0.0" })) } };
    },
    invoke(input) { return { outcome: "accepted", value: parseProjectPackV2(input) }; },
    expectedErrors: expected,
    oracle(input, result) {
      if (result.outcome !== "accepted") return undefined;
      const pack = result.value;
      const ids = pack.modules.map(m => m.id);
      if (new Set(ids).size !== ids.length) return "accepted duplicate module ids";
      if (ids.some((id, i) => i && ids[i - 1].localeCompare(id) > 0)) return "accepted non-canonical order";
      if (pack.modules.length > 100) return "accepted >100 modules";
      return checkTextInvariant(pack);
    },
  },
  {
    name: "module-manifest",
    corpus: [manifest(), codeManifest()],
    generate(rng, corpus) {
      const r = rng.float();
      if (r < 0.8) return { $label: "mutate", $input: rng.mutate(rng.pick(corpus), rng.int(1, 5)) };
      if (r < 0.9) return { $label: "random", $input: rng.jsonValue(0, 6) };
      const m = manifest(); m.skills = Array.from({ length: rng.int(1, 60) }, (_, i) => ({ ...skill, id: `s${i}abc`, contentDigest: sha256Digest({ schema: "control-room.module-shared-skill/v1", ...skill, id: `s${i}abc` }) }));
      m.skills[0].instructions = "x".repeat(rng.int(1, 13000));
      return { $label: "many-skills", $input: m };
    },
    invoke(input) { return { outcome: "accepted", value: parseModuleManifestV1(input) }; },
    expectedErrors: expected,
    oracle(input, result) {
      if (result.outcome !== "accepted") return undefined;
      const m = result.value;
      if (!/^[a-z][A-Za-z0-9.-]{2,63}$/u.test(m.id)) return "accepted bad module id";
      if (m.skills?.length && m.class !== "declarative") return "accepted skills on a code module";
      if (m.data && m.data.schemaNamespace !== `module_${m.id.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[.-]/g, "_").toLowerCase()}`) return "accepted namespace mismatch";
      if (Buffer.byteLength(JSON.stringify(input)) > 131072) return "accepted oversize manifest";
      return checkTextInvariant(m);
    },
  },
  {
    name: "module-bundle",
    corpus: [bundle()],
    corpusInput: b => ({ bundle: b, signature: null }),
    generate(rng, corpus, i) {
      const r = rng.float();
      if (r < 0.35) return { $label: "mutate-bundle", $input: { bundle: rng.mutate(corpus[0], rng.int(1, 4)), signature: null } };
      if (r < 0.6) { const md = markdownBomb(rng, i < 400); return { $label: "markdown-bomb", $input: { bundle: bundle([{ path: "p.md", contentBase64: b64(md) }]), signature: null } }; }
      if (r < 0.75) { const text = rng.mutateText(rng.pick(['{"a":1,"b":{"c":[1,2]}}', '{"x":"<b>"}', '{"__proto__":{"p":1}}', '{"a":1,"a":2}', '{"k":"\\u003cscript"}']), rng.int(0, 3)); return { $label: "json-file", $input: { bundle: bundle([{ path: "c.json", contentBase64: b64(text) }]), signature: null } }; }
      if (r < 0.85) { const path = rng.pick(["a/b/c.md", "CON.md", "a.", "../x.md", "a//b.md", "A.md", "x.exe", ".hidden.md", "a/".repeat(10) + "z.md", "n.md\u0000"]); return { $label: "path", $input: { bundle: bundle([{ path: rng.bool(0.5) ? path : rng.mutateString(path), contentBase64: b64("ok") }]), signature: null } }; }
      if (r < 0.95) { const b = bundle(); const sig = signModuleBundleV1(b, keys.privateKey, spki); return { $label: "signature-mutate", $input: { bundle: rng.bool(0.3) ? rng.mutate(b, 1) : b, signature: rng.mutate(sig, rng.int(1, 2)) } }; }
      const md = rng.pick(["[x](javascript:alert(1))", "![i](data:text/html,hi)", "[x]: javascript:x", "<img src=x onerror=1>", "a <b", "<!-- c -->", "[x](<javascript:a>)", "[x](java\u0000script:a)", "[x](JAVASCRIPT:a)", "[x](&#106;avascript:a)", "[x](vbscript:a)"]);
      return { $label: "md-link", $input: { bundle: bundle([{ path: "l.md", contentBase64: b64(rng.bool(0.5) ? md : rng.mutateString(md)) }]), signature: null } };
    },
    timeoutMs: 15000,
    invoke(input) {
      const verified = verifyModuleBundleV1(input.bundle, input.signature, options);
      return { outcome: "accepted", value: verified };
    },
    expectedErrors: expected,
    oracle(input, result) {
      if (result.outcome !== "accepted") return undefined;
      const v = result.value;
      if (v.moduleClass === "code" && v.source.kind === "declarative-unsigned") return "code module accepted without trusted source";
      if (v.source.kind === "signed") {
        const sig = input.signature;
        if (!sig || sig.bundleDigest !== v.bundleDigest) return "signed source accepted with mismatched digest";
      }
      for (const f of input.bundle.files ?? []) {
        if (typeof f?.path !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}(\/[a-z0-9][a-z0-9._-]{0,63})*$/u.test(f.path)) return `accepted unsafe path ${String(f?.path).slice(0, 40)}`;
        if (v.moduleClass === "declarative") {
          const text = Buffer.from(f.contentBase64, "base64").toString("utf8");
          if (/\.(md|txt)$/u.test(f.path) && /javascript:|vbscript:|data:/iu.test(text) && /\]\(\s*(javascript|vbscript|data):[^\s)]*\)/iu.test(text)) return "accepted markdown with a script-scheme link";
          if (/<[A-Za-z/!?]/u.test(text)) return "accepted raw HTML in declarative file";
          if (!/\.(json|md|txt)$/u.test(f.path)) return "accepted non-declarative extension";
        }
      }
      return undefined;
    },
  },
];
