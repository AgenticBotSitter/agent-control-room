import { createHash } from 'node:crypto';
import { createFleetReleaseTrustForTestV1 } from './fleet-release.ts';
export const trust = createFleetReleaseTrustForTestV1().trust;
export const digest = value => `sha256:${createHash('sha256').update(value).digest('hex')}`;
export const db = { host: '127.0.0.1', port: 5432, database: 'control_room', username: 'control_room_web', password: 'synthetic-test-only', majorVersion: 17 };
export const mac = { schema: 'control-room.mac-local-protected-configuration/v1', port: 13210, workspaceId: 'workspace:qa',
  localOwnerSession: { schema: 'control-room.local-owner-session/v1', origin: 'http://127.0.0.1:13210', tenantId: 'tenant:qa', provider: 'local-owner', subject: 'owner:qa', ownerCodeDigest: digest('synthetic-owner-code'), sessionSeconds: 900 },
  database: db, enablement: { schema: 'control-room.owner-trusted-local-enablement/v1', mode: 'mac-local', nodeId: 'mac-1', workers: [] } };
export const gateway = { schema: 'control-room.fleet-gateway/v1', tenantId: 'tenant:qa', port: 13211,
  database: { ...db, username: 'control_room_fleet' }, releaseTrust: trust };
export const accounts = Object.fromEntries(['builder','database','service'].map((key, i) => [key, { name: `_qa_${key}`, uid: 400+i, gid: 400+i, created: true }]));
export function composer(root = '/neutral/install') {
  const names = ['control_room_fleet','control_room_fleet_owner','control_room_migrator','control_room_web','control_room_work_intake_agent','control_room_coordinator','control_room_results','control_room_publisher','control_room_agent_reviewer_login','control_room_queue_worker'];
  return { root, accounts: structuredClone(accounts), installationId: 'qa-install', rpId: 'qa.example.ts.net', webPort: 13210, gatewayPort: 13211,
    tenant: { tenantId: 'tenant:qa', workspaceId: 'workspace:qa', provider: 'local-owner', subject: 'owner:qa' }, ownerCodeDigest: digest('synthetic-only'), releaseTrust: trust,
    dbLogins: names.map((name, i) => { const password = Buffer.alloc(32,i+1).toString('base64url'); return { name, password, passwordDigest: digest(password), fileRef: `${root}/Protected/config/database-passwords/${name}.txt` }; }),
    keys: { vapidPrivate: `${root}/updater-state/vapid.json`, vapidPublic: `${root}/Protected/service/vapid-public.json`, healthProbeRoot: `${root}/updater-state/health-probe.key`, healthProbeService: `${root}/Protected/service/health-probe.key`,
      webHmac: { fileRef: `${root}/Protected/service/web-hmac.key`, value: Buffer.alloc(32,30).toString('base64url') }, workIntake: { fileRef: `${root}/Protected/service/work-intake.json`, integrityKey: Buffer.alloc(32,31).toString('base64url') } } };
}
