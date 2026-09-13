// Restricted website, optionally with saved Idea/news data. No runtime or worker.
// Keep this file in deploy/ within the pinned release and chmod 0600 on the server.
import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { validatePrivateVpsConfigurationPath } from '../scripts/run-private-vps.mjs';
import { createAccessKeyLoader, createStaticAccessKeyLoader, validatePrivateStartupConfiguration } from '../dist-vps/server/bootstrap.js';
import { validatePrivateIdeaAuthoringConfiguration } from '../dist-vps/server/ideaAuthoring.js';
import { parseProductConfigurationV1 } from '../dist-vps/server/productConfiguration.js';

export const schema = 'control-room.private-vps-configuration/v1';
export async function createConfiguration({ signal }) {
  if (signal.aborted) throw new Error('operator_setup_canceled');
  const path = process.env.CONTROL_ROOM_SETTINGS_FILE;
  if (!path || !isAbsolute(path)) throw new Error('operator_settings_required');
  await validatePrivateVpsConfigurationPath(path);
  const settings = JSON.parse(await readFile(path, { encoding: 'utf8', signal }));
  if (!settings || !['port,web', 'port,savedViews,web', 'ideaAuthoring,port,savedViews,web',
    'port,productConfiguration,web', 'port,productConfiguration,savedViews,web',
    'ideaAuthoring,port,productConfiguration,savedViews,web'].includes(Object.keys(settings).sort().join(','))
    || !Number.isSafeInteger(settings.port) || settings.port < 1024 || settings.port > 65535)
    throw new Error('operator_settings_invalid');
  const requiredWeb = ['audience', 'database', 'issuer', 'maxSessionSeconds', 'origin',
    'ownerIdentityId', 'tenantId', 'workspaceId'];
  // Optional second-provider wiring: the fixed RS256 gateway-assertion profile
  // plus its deployment-selected static public keys. The Cloudflare profile
  // (default) keeps the fetched key loader and must not carry static keys.
  const optionalWeb = ['gatewayAssertionProfile', 'staticKeys'];
  if (!settings.web || typeof settings.web !== 'object' || Array.isArray(settings.web))
    throw new Error('operator_settings_invalid');
  const webKeys = Object.keys(settings.web);
  if (webKeys.some(key => !requiredWeb.includes(key) && !optionalWeb.includes(key))
    || requiredWeb.some(key => !webKeys.includes(key)))
    throw new Error('operator_settings_invalid');
  const optional = {};
  if ('savedViews' in settings) {
    const saved = settings.savedViews;
    if (!saved || Array.isArray(saved) || typeof saved !== 'object' || !Object.keys(saved).length
      || Object.keys(saved).some(name => !['ideaIntegrityKeyHex', 'newsIntegrityKeyHex'].includes(name)))
      throw new Error('operator_settings_invalid');
    for (const [name, value] of Object.entries(saved)) {
      if (typeof value !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value)) throw new Error('operator_settings_invalid');
      optional[name === 'ideaIntegrityKeyHex' ? 'ideaProjects' : 'news'] = { integrityKey: Uint8Array.from(Buffer.from(value, 'hex')) };
    }
  }
  let productConfiguration;
  try {
    productConfiguration = settings.productConfiguration === undefined ? undefined
      : parseProductConfigurationV1(settings.productConfiguration);
  } catch { throw new Error('operator_settings_invalid'); }
  // Second-provider key routing. The default (absent or Cloudflare) profile
  // keeps the fetched Cloudflare certs loader; the fixed RS256 profile uses
  // the built-in static loader over deployment-selected keys from this file.
  // Static keys beside the Cloudflare profile, a missing staticKeys beside
  // the RS256 profile, and any other profileId are all refused. Full profile
  // shape capture stays downstream in validatePrivateStartupConfiguration.
  const provider = settings.web.gatewayAssertionProfile;
  const providerId = typeof provider === 'object' && provider !== null ? provider.profileId : undefined;
  let loadKeys;
  if (provider === undefined || providerId === 'cloudflare_access') {
    if ('staticKeys' in settings.web) throw new Error('operator_settings_invalid');
    try { loadKeys = createAccessKeyLoader(settings.web.issuer, fetch); }
    catch { throw new Error('operator_settings_invalid'); }
  } else if (providerId === 'rs256_gateway_assertion') {
    if (!Array.isArray(settings.web.staticKeys)) throw new Error('operator_settings_invalid');
    try { loadKeys = createStaticAccessKeyLoader(settings.web.staticKeys); }
    catch { throw new Error('operator_settings_invalid'); }
  } else throw new Error('operator_settings_invalid');
  // staticKeys is consumed above (key loader); it is not a startup field.
  const { staticKeys: _consumedStaticKeys, ...webSettings } = settings.web;
  void _consumedStaticKeys;
  const web = validatePrivateStartupConfiguration({ ...webSettings,
    ...optional,
    ...(productConfiguration === undefined ? {} : { productConfiguration }),
    loadKeys });
  const configuration = 'ideaAuthoring' in settings
    ? validatePrivateIdeaAuthoringConfiguration({ web, ideaAuthoring: settings.ideaAuthoring }) : { web };
  return { mode: 'website-only', port: settings.port, configuration };
}
