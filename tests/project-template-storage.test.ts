import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildProjectPresentationV1, computeAvailableProjectModulesV1, computeEffectiveProjectPresentationV1,
  parseStoredProjectPresentationV1, ProjectPresentationError, resolveProjectTemplateV1,
  verifyProjectTemplateSelectionV1,
} from '../src/config/v1/project-presentation';
import {
  PRODUCT_CONFIGURATION_MODULES_V1, parseProductConfigurationV1, productConfigurationSchemaV1,
  type ProductConfigurationV1,
} from '../src/config/v1/product-configuration';
import { sha256Digest } from '../src/security/digest';

function configurationWith(overrides: Partial<ProductConfigurationV1> = {}): Readonly<ProductConfigurationV1> {
  const base: ProductConfigurationV1 = {
    schema: 'control-room.product-configuration/v1',
    displayName: 'Test',
    defaultTimezone: 'UTC',
    modules: { ideaLab: true, news: true, sessionObservations: false },
    limits: { maxProjects: 10, maxTasksPerProject: 10, maxResultsPerTask: 10, maxArticleSources: 0, maxIdeaParticipants: 0 },
    projectTemplates: [
      { id: 'core-pages-only', displayName: 'Core pages only', enabledModules: [] },
      { id: 'news-focused', displayName: 'News focused', enabledModules: ['news'] },
      { id: 'idea-and-news', displayName: 'Idea and news', enabledModules: ['ideaLab', 'news'] },
    ],
  };
  const modules = { ...base.modules, ...(overrides.modules ?? {}) };
  const templates = (overrides.projectTemplates ?? base.projectTemplates)
    .map((template) => ({ ...template, enabledModules: template.enabledModules.filter((module) => modules[module]) }));
  return parseProductConfigurationV1({ ...base, ...overrides, modules, projectTemplates: templates });
}

test('verifyProjectTemplateSelectionV1 matches the trusted configuration digest exactly', () => {
  const configuration = configurationWith();
  const digest = sha256Digest(configuration);
  const candidate = verifyProjectTemplateSelectionV1(configuration,
    { templateId: 'news-focused', configurationDigest: digest }, digest);
  assert.equal(candidate.templateId, 'news-focused');
  assert.equal(candidate.displayName, 'News focused');
  assert.deepEqual(candidate.enabledModules, ['news']);
});

test('verifyProjectTemplateSelectionV1 rejects a stale digest', () => {
  const configuration = configurationWith();
  const digest = sha256Digest(configuration);
  assert.throws(() => verifyProjectTemplateSelectionV1(configuration,
    { templateId: 'news-focused', configurationDigest: `sha256:${'a'.repeat(64)}` }, digest),
    error => error instanceof ProjectPresentationError && error.code === 'stale_digest');
});

test('verifyProjectTemplateSelectionV1 rejects an unknown template id', () => {
  const configuration = configurationWith();
  const digest = sha256Digest(configuration);
  assert.throws(() => verifyProjectTemplateSelectionV1(configuration,
    { templateId: 'mystery-template', configurationDigest: digest }, digest),
    error => error instanceof ProjectPresentationError && error.code === 'unknown_template');
});

test('productConfigurationSchemaV1 rejects a template whose modules are not globally enabled at parse time', () => {
  // This is the upstream defense; verifyProjectTemplateSelectionV1 is the runtime defense if
  // a configuration is constructed by other means (e.g. an operator-injected dev override).
  assert.throws(() => productConfigurationSchemaV1.parse({
    schema: 'control-room.product-configuration/v1', displayName: 'Test', defaultTimezone: 'UTC',
    modules: { ideaLab: false, news: true, sessionObservations: false },
    limits: { maxProjects: 10, maxTasksPerProject: 10, maxResultsPerTask: 10, maxArticleSources: 0, maxIdeaParticipants: 0 },
    projectTemplates: [{ id: 'idea-only', displayName: 'Idea only', enabledModules: ['ideaLab'] }],
  }), /template_module_not_enabled/);
});

test('verifyProjectTemplateSelectionV1 catches a disabled module even when the config was assembled by other means', () => {
  // Build a config that passes the type but has a template module disabled globally, by using
  // the strict schema's permissive path: pass `enabledModules: ['ideaLab']` and a config where
  // `modules.ideaLab` is `true` so parse accepts, then mutate the runtime view to disable the module.
  const strictConfig = configurationWith({ modules: { ideaLab: true, news: false, sessionObservations: false },
    projectTemplates: [{ id: 'idea-only', displayName: 'Idea only', enabledModules: ['ideaLab'] }] });
  // Now construct a runtime view of the same config but with `ideaLab` flipped off.
  const runtimeView = { ...strictConfig, modules: { ...strictConfig.modules, ideaLab: false } } as Readonly<ProductConfigurationV1>;
  const digest = sha256Digest(strictConfig); // browser sends the digest it saw
  assert.throws(() => verifyProjectTemplateSelectionV1(runtimeView,
    { templateId: 'idea-only', configurationDigest: digest }, digest),
    error => error instanceof ProjectPresentationError && error.code === 'disabled_modules');
});

test('buildProjectPresentationV1 freezes the snapshot and orders enabled modules canonically', () => {
  const configuration = configurationWith();
  const digest = sha256Digest(configuration);
  const template = resolveProjectTemplateV1(configuration, 'idea-and-news');
  const presentation = buildProjectPresentationV1(template, digest);
  assert.equal(presentation.schema, 'control-room.project-presentation/v1');
  assert.equal(presentation.templateId, 'idea-and-news');
  assert.equal(presentation.configurationDigest, digest);
  assert.equal(presentation.templateDisplayName, 'Idea and news');
  // Modules come back in PRODUCT_CONFIGURATION_MODULES_V1 order, regardless of input order.
  assert.deepEqual([...presentation.enabledModules], ['ideaLab', 'news']);
  assert.equal(Object.isFrozen(presentation), true);
  assert.equal(Object.isFrozen(presentation.enabledModules), true);
});

test('parseStoredProjectPresentationV1 rejects malformed stored data without falling back', () => {
  // Missing required templateId.
  assert.throws(() => parseStoredProjectPresentationV1({ schema: 'control-room.project-presentation/v1',
    configurationDigest: `sha256:${'a'.repeat(64)}`, templateDisplayName: 'X', enabledModules: [] }),
    error => error instanceof ProjectPresentationError && error.code === 'malformed_stored');
  // Wrong schema.
  assert.throws(() => parseStoredProjectPresentationV1({ schema: 'wrong', templateId: 'core-pages-only',
    configurationDigest: `sha256:${'a'.repeat(64)}`, templateDisplayName: 'X', enabledModules: [] }),
    error => error instanceof ProjectPresentationError && error.code === 'malformed_stored');
  // Out-of-order enabled modules.
  assert.throws(() => parseStoredProjectPresentationV1({ schema: 'control-room.project-presentation/v1',
    templateId: 'news-focused', configurationDigest: `sha256:${'a'.repeat(64)}`, templateDisplayName: 'News focused',
    enabledModules: ['news', 'ideaLab'] }),
    error => error instanceof ProjectPresentationError && error.code === 'malformed_stored');
  // Duplicate modules.
  assert.throws(() => parseStoredProjectPresentationV1({ schema: 'control-room.project-presentation/v1',
    templateId: 'idea-and-news', configurationDigest: `sha256:${'a'.repeat(64)}`, templateDisplayName: 'Idea and news',
    enabledModules: ['news', 'news'] }),
    error => error instanceof ProjectPresentationError && error.code === 'malformed_stored');
  // A stored payload that carries an invalid .presentation must throw — not silently fall back to legacy.
  assert.throws(() => parseStoredProjectPresentationV1({ projectKind: 'general', origin: 'manual', createdAt: 'x',
    presentation: { schema: 'wrong', templateId: 't', configurationDigest: `sha256:${'a'.repeat(64)}`,
      templateDisplayName: 'X', enabledModules: [] } }),
    error => error instanceof ProjectPresentationError && error.code === 'malformed_stored');
  // A stored payload with no .presentation field at all is a legacy row (returns undefined).
  assert.equal(parseStoredProjectPresentationV1({ projectKind: 'general', origin: 'manual', createdAt: 'x' }), undefined);
});

test('computeAvailableProjectModulesV1 intersects saved snapshot with current global modules', () => {
  const configuration = configurationWith({
    modules: { ideaLab: false, news: true, sessionObservations: false },
  });
  const digest = sha256Digest(configuration);
  const presentation = buildProjectPresentationV1(
    resolveProjectTemplateV1(configuration, 'idea-and-news'), digest);
  // Saved has ideaLab+news; only news is currently enabled -> availableModules is ['news'] only.
  assert.deepEqual(computeAvailableProjectModulesV1(presentation, configuration), ['news']);
});

test('computeEffectiveProjectPresentationV1 reports templateRemoved when template is no longer configured', () => {
  const first = configurationWith();
  const digest = sha256Digest(first);
  const presentation = buildProjectPresentationV1(resolveProjectTemplateV1(first, 'news-focused'), digest);
  const second = configurationWith({ projectTemplates: [{ id: 'core-pages-only', displayName: 'Core pages only',
    enabledModules: [] }] });
  const effective = computeEffectiveProjectPresentationV1(presentation, second);
  assert.equal(effective.templateRemoved, true);
  assert.deepEqual([...effective.enabledModules], ['news']);
  assert.deepEqual([...effective.availableModules], []);
});

test('computeEffectiveProjectPresentationV1 returns the legacy-global presentation when none is stored', () => {
  const configuration = configurationWith({
    modules: { ideaLab: true, news: false, sessionObservations: false },
  });
  const effective = computeEffectiveProjectPresentationV1(undefined, configuration);
  assert.equal(effective.source, 'legacy_global');
  assert.equal(effective.templateId, '');
  assert.deepEqual([...effective.enabledModules], []);
  assert.deepEqual([...effective.availableModules], ['ideaLab']);
  assert.equal(effective.templateRemoved, false);
});

test('computeEffectiveProjectPresentationV1 with no running configuration reports no availability', () => {
  const presentation = parseStoredProjectPresentationV1({
    schema: 'control-room.project-presentation/v1', templateId: 'news-focused',
    configurationDigest: `sha256:${'a'.repeat(64)}`, templateDisplayName: 'News focused', enabledModules: ['news'],
  });
  const effective = computeEffectiveProjectPresentationV1(presentation, undefined);
  assert.deepEqual([...effective.availableModules], []);
  assert.equal(effective.templateRemoved, true); // not in any configuration -> treated as removed
});

test('PRODUCT_CONFIGURATION_MODULES_V1 order is the canonical ordering', () => {
  assert.deepEqual([...PRODUCT_CONFIGURATION_MODULES_V1], ['ideaLab', 'news', 'sessionObservations']);
});
