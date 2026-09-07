// Read-only planning inventory. No copying, deletion, license grant or publication.
import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import ts from 'typescript';
import { publicExportImports } from './public-export-imports.mjs';

const root = process.cwd();
const args = process.argv.slice(2);
if (new Set(args).size !== args.length || args.some(arg => !['--with-compiled-tests', '--with-contributor-demo'].includes(arg))) throw new Error('Unknown inventory option');
const includeCompiledTests = args.includes('--with-compiled-tests');
const includeContributorDemo = args.includes('--with-contributor-demo');
const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
const baseline = git(['rev-parse', 'HEAD']).trim();
const files = git(['ls-files', '-z']).split('\0').filter(Boolean).sort();
// The report is a derived artifact, never an input to its own inventory.
const reportPath = 'docs/research/public-export-inventory.json';
const tracked = new Set(files.filter(file => file !== reportPath));
// Reuse the compiler's standalone roots, including framework middleware. Maintaining
// another entry-point list here previously omitted that non-imported framework hook.
const parsed = ts.getParsedCommandLineOfConfigFile('tsconfig.vps.json', {}, {
  ...ts.sys,
  onUnRecoverableConfigFileDiagnostic: diagnostic => {
    throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
  },
});
if (!parsed || parsed.errors.length) throw new Error('Invalid standalone TypeScript configuration');
const { options } = parsed;
const compilerSeeds = parsed.fileNames.map(file => path.relative(root, file)).sort();
const seeds = [...compilerSeeds, 'scripts/build-vps.mjs', 'scripts/run-private-vps.mjs'];
const testSeeds = includeCompiledTests ? [...new Set([
  ...(JSON.parse(readFileSync('package.json', 'utf8')).scripts['test:build:vps'].match(/tests\/[A-Za-z0-9_./-]+\.test\.[cm]?[jt]sx?/g) ?? []),
  'tests/vps-build-profile.test.ts', 'tests/private-vps-launcher.test.mjs',
])] : [];
seeds.push(...testSeeds);
const demoSeeds = includeContributorDemo ? ['scripts/contributor-demo.mjs', 'vite.contributor.config.ts',
  'contributor-demo/index.html', 'contributor-demo/main.tsx', 'tests/contributor-demo-launcher.test.ts',
  'tests/contributor-demo-runtime.test.ts', 'tests/contributor-demo-build.test.mjs',
  'tests/local-preview-panels.test.tsx', 'tests/web-private-serving.test.ts'] : [];
seeds.push(...demoSeeds);
const pending = [...seeds], closure = new Set(), unresolved = [], dynamic = [], external = new Set();
while (pending.length) {
  const file = pending.pop();
  if (closure.has(file)) continue;
  if (!tracked.has(file)) { unresolved.push({ file, reason: 'not_tracked_source' }); continue; }
  closure.add(file);
  if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
  if (!lstatSync(file).isFile()) { unresolved.push({ file, reason: 'not_regular_file' }); continue; }
  const scanned = publicExportImports(file, readFileSync(file, 'utf8'));
  const imports = scanned.imports;
  dynamic.push(...scanned.dynamic);
  for (const specifier of imports) {
    if (specifier.endsWith('.css')) {
      pending.push(path.relative(root, path.resolve(path.dirname(path.resolve(file)), specifier))); continue;
    }
    const resolved = ts.resolveModuleName(specifier, path.resolve(file), options, ts.sys).resolvedModule;
    if (!resolved) {
      if (specifier.startsWith('.') || specifier.startsWith('@/')) unresolved.push({ file, specifier, reason: 'unresolved_local_import' });
      else external.add(specifier);
      continue;
    }
    const relative = path.relative(root, resolved.resolvedFileName);
    if (relative.startsWith('node_modules/')) external.add(specifier);
    else pending.push(relative);
  }
}

function proposal(file) {
  if (closure.has(file)) return ['review', 'application_or_build_import'];
  if (file === 'public/favicon.svg') return ['review', 'startup_required_original_asset_license_pending'];
  if (/^(docs|coordination|reviews|\.agents|\.github|\.openai|release)\//.test(file))
    return ['exclude', 'private_history_or_configuration_default'];
  if (/^(tests|db|contracts|schemas|third_party)\//.test(file)) return ['review', 'supporting_tests_schema_or_attribution'];
  if (/^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig(?:\.vps)?\.json|eslint\.config\.mjs|postcss\.config\.mjs|next-env\.d\.ts|next\.config\.ts|middleware\.ts)$/.test(file))
    return ['adapt', 'root_build_or_verification_scope'];
  return ['unresolved', 'manual_scope_decision_required'];
}
const counts = {};
const entries = [...tracked].map(file => {
  const stat = lstatSync(file), regular = stat.isFile();
  const [disposition, reason] = regular ? proposal(file) : ['unresolved', 'nonregular_path'];
  counts[disposition] = (counts[disposition] ?? 0) + 1;
  return { path: file, disposition, reason, review: 'pending',
    sha256: regular ? createHash('sha256').update(readFileSync(file)).digest('hex') : null };
});
console.log(JSON.stringify({ schema: 'control-room.public-export-planning-inventory/v1', baseline,
  source: 'tracked_working_tree_bytes', publicationApproved: false, counts,
  limitations: ['Proposals are not content review or an export allowlist.',
    'CSS dependencies, runtime file reads and framework discovery require review.',
    'Built-output imports from the launcher are expected outside tracked source; builds must supply them.',
    'Untracked and ignored files are not inventoried; never copy them implicitly.',
    'Private planning report; contains internal paths and must not be published.'],
  closureCount: closure.size, compilerSeeds, testSeeds, demoSeeds, external: [...external].sort(), dynamic, unresolved, entries }, null, 2));
