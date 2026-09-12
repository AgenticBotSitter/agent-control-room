// Walks the declared production dependency closure and records, for each package,
// the license it declares and the license/notice files it actually ships.
//
// This is deliberately narrow. Apache-2.0 section 4(d) requires retaining the
// NOTICE files of Apache-licensed dependencies, and BSD/MIT require retaining
// their copyright text, so any redistribution needs to know which installed
// packages carry that text and which declare a license and ship none.
//
// It reads the production closure. THIRD_PARTY.md records what the wider
// development closure looks like and why it is out of scope for this preview.
//
// Resolution follows Node's own algorithm - walk up from the dependent's real
// directory looking for node_modules/<name> - rather than assuming every package
// sits at the top level. pnpm puts transitive dependencies under node_modules/.pnpm
// and links them beneath their dependents, so a top-level-only scan silently
// reports most of the closure as "not installed". realpath() before recursing,
// or the walk stops at the symlink's parent instead of the store directory.
//
// It reads only what is installed. A package listed as `installed: false` is
// depended upon but could not be resolved, so its license is unknown here rather
// than absent - the inventory is incomplete, not clean.
//
// This produces evidence. It grants nothing, certifies nothing, and is not
// clearance to distribute anything.
import { readFileSync, existsSync, readdirSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";

const LICENSE_FILE = /^(notice|license|licence|copying)/i;
const manifest = JSON.parse(readFileSync("package.json", "utf8"));

/** Node's resolution, by hand: up the directory chain, checking each node_modules. */
function findPackageDir(name, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// MIT and BSD require retaining the copyright notice and permission text, so what
// matters is whether that text is present anywhere - not whether it sits in a file
// named LICENSE. Several packages ship it only as a README section. Distinguishing
// the two from "the package names a license and supplies no text at all" is the
// whole point: only the last is a gap, and it is the only one needing a human.
const PERMISSION_TEXT = /permission is hereby granted|redistribution and use in source|licensed under the apache license|this is free and unencumbered software/i;

function licenseTextLocation(dir, files) {
  if (files.length > 0) return "license-file";
  const readme = readdirSync(dir).find(file => /^readme/i.test(file));
  if (readme && PERMISSION_TEXT.test(readFileSync(join(dir, readme), "utf8"))) return "readme";
  return "none";
}

const packages = new Map();
function visit(name, fromDir) {
  if (packages.has(name)) return;
  const dir = findPackageDir(name, fromDir);
  if (!dir) {
    packages.set(name, { installed: false });
    return;
  }
  const dependency = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const declared = dependency.license
    ?? (dependency.licenses ? JSON.stringify(dependency.licenses) : undefined);
  const files = readdirSync(dir).filter(file => LICENSE_FILE.test(file)).sort();
  packages.set(name, {
    installed: true,
    version: dependency.version,
    // "UNDECLARED" is a finding, not a default: a package that states no license
    // grants no redistribution rights, so it cannot simply be shipped.
    license: declared ?? "UNDECLARED",
    files,
    textLocation: licenseTextLocation(dir, files),
  });
  // Recurse from the package's real directory so pnpm's per-package links resolve.
  for (const transitive of Object.keys(dependency.dependencies ?? {})) visit(transitive, dir);
}
const root = realpathSync(resolvePath("."));
for (const direct of Object.keys(manifest.dependencies ?? {})) visit(direct, root);

const entries = [...packages.entries()].sort(([a], [b]) => a.localeCompare(b));
const unresolved = entries.filter(([, value]) => !value.installed).map(([name]) => name);
// The case that needs a human: the package names a license but supplies no text
// for it anywhere, so there is no copyright notice to retain and nothing to pass
// downstream. A package carrying its text only in the README is not this case.
const missingText = entries
  .filter(([, value]) => value.installed && value.textLocation === "none")
  .map(([name, value]) => ({ name, license: value.license }));
const readmeOnly = entries
  .filter(([, value]) => value.installed && value.textLocation === "readme")
  .map(([name, value]) => ({ name, license: value.license }));
const byLicense = {};
for (const [, value] of entries) {
  if (!value.installed) continue;
  byLicense[value.license] = (byLicense[value.license] ?? 0) + 1;
}

const report = {
  generatedFrom: "package.json dependencies, resolved against the local install",
  grantsCertification: false,
  grantsReleaseAuthority: false,
  packageCount: entries.length,
  byLicense,
  unresolved,
  licenseTextInReadmeOnly: readmeOnly,
  noLicenseTextAnywhere: missingText,
  packages: Object.fromEntries(entries),
};
writeFileSync("docs/license-inventory.json", `${JSON.stringify(report, null, 2)}\n`);

console.log(`packages in closure: ${entries.length} (${unresolved.length} unresolved)`);
for (const [license, count] of Object.entries(byLicense).sort()) console.log(`  ${license}: ${count}`);
if (unresolved.length) console.log(`unresolved: ${unresolved.join(", ")}`);
if (readmeOnly.length) {
  console.log("license text present, but in the README rather than a license file:");
  for (const { name, license } of readmeOnly) console.log(`  ${name} (${license})`);
}
if (missingText.length) {
  console.log("declares a license but supplies no text for it anywhere:");
  for (const { name, license } of missingText) console.log(`  ${name} (${license})`);
}
