import test from 'node:test';
import assert from 'node:assert/strict';
import { mac, gateway, composer } from './support/hardening-config.mjs';
import { captureMacLocalProtectedConfigurationV1 as captureMac } from '../src/web/v1/mac-local-protected-configuration.ts';
import { captureMacLocalDatabaseRolesV1 } from '../src/web/v1/mac-local-database-roles.ts';
import { captureFleetGatewayConfigurationV1 as captureGateway } from '../scripts/run-fleet-gateway.ts';
import { composeProtectedConfigV1 } from '../src/updater/v1/services/protected-config.mjs';
import { captureReleaseTrustV1 } from '../scripts/release-signing.mjs';
const parsers={captureMacLocalProtectedConfigurationV1:captureMac,captureMacLocalDatabaseRolesV1,captureReleaseTrustV1};
const clone=x=>structuredClone(x);
test('A2-02 gateway and owner session refuse malformed identities and unknown fields', () => {
  for(const tenantId of ['', 'tenant\0qa','tenant\nqa','x'.repeat(100000)]) assert.throws(()=>captureGateway({...gateway,tenantId}),/fleet_gateway_configuration_refused/);
  for(const name of ['extra','__proto__','constructor']) { const value=clone(gateway); Object.defineProperty(value,name,{value:true,enumerable:true}); assert.throws(()=>captureGateway(value),/fleet_gateway_configuration_refused/); }
  assert.throws(()=>captureGateway({...gateway,workIntake:null}), /fleet_gateway_configuration_refused/);
  for(const field of ['tenantId','provider','subject']) for(const value of ['bad\0identity','bad\nidentity','x'.repeat(100000)]) {
    assert.throws(()=>captureMac({...mac,localOwnerSession:{...mac.localOwnerSession,[field]:value}}));
  }
  assert.throws(()=>captureMac({...mac,localOwnerSession:{...mac.localOwnerSession,extra:true}}));
});

test('A2-09 composer refuses coerced scalars before emitting resources',()=>{
  assert.equal(composeProtectedConfigV1(composer(),parsers).length,9);
  const fields=[['installationId'],['rpId'],['ownerCodeDigest'],['accounts','builder','name'],['keys','webHmac','value'],['keys','workIntake','integrityKey'],['dbLogins',0,'passwordDigest']];
  for(const path of fields){const good=composer();let parent=good;for(const key of path.slice(0,-1))parent=parent[key];const key=path.at(-1),original=parent[key];
    for(const bad of [null,true,123,[original]]){parent[key]=bad;let captures=0;const observed=Object.fromEntries(Object.entries(parsers).map(([name,parse])=>[name,value=>{captures++;return parse(value);} ]));assert.throws(()=>composeProtectedConfigV1(good,observed),/protected_configuration_input_refused/);assert.equal(captures,0,'invalid composer scalars refuse before release parser calls');}
  }
});

test('configuration: exact own objects, nested types and Unicode identities', () => {
  assert.equal(captureGateway(gateway).tenantId,gateway.tenantId);
  assert.equal(captureMac({...mac,localOwnerSession:{...mac.localOwnerSession,provider:'利用者',subject:'owner:é🙂'}}).localOwnerSession.subject,'owner:é🙂');
  for (const value of [null, [], Object.create(gateway)]) assert.throws(()=>captureGateway(value), /fleet_gateway_configuration_refused/);
  for (const workIntake of [null, [], {database:null,integrityKey:'a'.repeat(43)}, {database:gateway.database,integrityKey:'a'.repeat(43),extra:true}])
    assert.throws(()=>captureGateway({...gateway,workIntake}), /fleet_gateway_configuration_refused/);
  assert.throws(()=>captureGateway({...gateway,database:null}), /fleet_gateway_configuration_refused/);
  assert.throws(()=>captureMac({...mac,localOwnerSession:Object.create(mac.localOwnerSession)}));
});
