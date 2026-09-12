// Walks the declared production dependency closure and records, for each package,
// the license it declares and the license/notice files it actually ships.
//
// This is deliberately narrow. It answers one question the existing mechanical
// audit does not: Apache-2.0 section 4(d) requires retaining the NOTICE files of
// Apache-licensed dependencies, and BSD/MIT require retaining their copyright
// text, so any redistribution needs to know which installed packages carry those
// files and which declare a license but ship no text at all.
//
// It reads only what is installed. A package listed as `installed: false` is
// declared in package.json but absent from node_modules, so its license is
// unknown here rather than absent - the inventory is incomplete, not clean.
//
// This produces evidence. It grants nothing: it does not close
// notice_attribution_review, and it is not a release authority.
import { readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";

const LICENSE_FILE = /^(notice|license|licence|copying)/i;
const manifest = JSON.parse(readFileSync("package.json", "utf8"));

const packages = new Map();
function visit(name) {
  if (packages.has(name)) return;
  const manifestPath = `node_modules/${name}/package.json`;
  if (!existsSync(manifestPath)) {
    packages.set(name, { installed: false });
    return;
  }
  const dependency = JSON.parse(readFileSync(manifestPath, "utf8"));
  const declared = dependency.license
    ?? (dependency.licenses ? JSON.stringify(dependency.licenses) : undefined);
  packages.set(name, {
    installed: true,
    version: dependency.version,
    // "UNDECLARED" is a finding, not a default: a package that states no license
    // grants no redistribution rights, so it cannot simply be shipped.
    license: declared ?? "UNDECLARED",
    files: readdirSync(`node_modules/${name}`).filter(file => LICENSE_FILE.test(file)).sort(),
  });
  for (const transitive of Object.keys(dependency.dependencies ?? {})) visit(transitive);
}
for (const direct of Object.keys(manifest.dependencies ?? {})) visit(direct);

const entries = [...packages.entries()].sort(([a], [b]) => a.localeCompare(b));
const inventory = Object.fromEntries(entries);
const notInstalled = entries.filter(([, value]) => !value.installed).map(([name]) => name);
// A package shipping no license file is the case that needs a human: the text
// has to come from somewhere else, or the package cannot be redistributed.
const missingText = entries
  .filter(([, value]) => value.installed && value.files.length === 0)
  .map(([name, value]) => ({ name, license: value.license }));
const byLicense = {};
for (const [, value] of entries) {
  if (!value.installed) continue;
  byLicense[value.license] = (byLicense[value.license] ?? 0) + 1;
}

const report = {
  generatedFrom: "package.json dependencies, resolved against the local node_modules",
  grantsCertification: false,
  grantsReleaseAuthority: false,
  packageCount: entries.length,
  byLicense,
  notInstalled,
  missingLicenseText: missingText,
  packages: inventory,
};
writeFileSync("docs/research/production-license-inventory.json", `${JSON.stringify(report, null, 2)}\n`);

console.log(`packages in closure: ${entries.length} (${notInstalled.length} not installed)`);
for (const [license, count] of Object.entries(byLicense).sort()) console.log(`  ${license}: ${count}`);
if (missingText.length) {
  console.log("declares a license but ships no license text:");
  for (const { name, license } of missingText) console.log(`  ${name} (${license})`);
}
