import {test,expect} from '@playwright/test';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import {taskFixture} from '../helpers/web-task';
import {now,origin,request,trust} from '../helpers/web-foundation';
import {LoopProviderServiceV1} from '../../src/web/v1/loop-provider-service';
import {createLoopProviderHttpHandlerV1} from '../../src/web/v1/loop-provider-http';
for(const width of [390,1280])test(`S1/S2 owner manages providers and refreshes recorded prices at ${width}px`,async({browser})=>{
 const f=await taskFixture();let context:Awaited<ReturnType<typeof browser.newContext>>|undefined;
 try{
  await f.db.query(`INSERT INTO control_loop_roster_models(tenant_id,name,position,launcher,provider,family,model_class,roles,efforts,default_effort,cost,on_off,note,nick,max_build_grade,updated_by,updated_at)
   VALUES('tenant:web','synthetic/model',1,'synthetic-api','','','','','','','','on','','','','identity:web',$1)`,[new Date(now).toISOString()]);
  let failSource=false;
  const service=new LoopProviderServiceV1(f.client,{tenantId:'tenant:web',workspaceId:'workspace:web'},{availability:async()=>{throw new Error('browser must not probe credentials');}},()=>now,{lookup:async()=>[{address:'8.8.8.8',family:4}],fetch:async()=>failSource?new Response('recorded failure',{status:500}):Response.json({schema:'control-room.provider-prices/v1',prices:[{model:'served/one',currency:'USD',inputUsdPerMillionTokens:'1.234',outputUsdPerMillionTokens:'2.5'},{model:'served/one',currency:'USD',inputUsdPerMillionTokens:'0.5',outputUsdPerMillionTokens:'1',window:{tz:'UTC',days:[0,6],start:'00:00',end:'12:00'}}]})});
  const handler=createLoopProviderHttpHandlerV1({origin,trust,service,clock:()=>now});
  const bundle=await build({write:false,bundle:true,platform:'browser',format:'iife',jsx:'automatic',stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {LoopProviderSection} from './private-app/app/loop-provider-panel';createRoot(document.getElementById('root')).render(<LoopProviderSection/>);`}});
  const css=await readFile('private-app/app/private.css','utf8'),unexpected:string[]=[];
  context=await browser.newContext({viewport:{width,height:900},isMobile:width<500,hasTouch:width<500});
  await context.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(url.origin!=='https://product.invalid'){unexpected.push(req.url());await route.abort();return;}
   if(url.pathname==='/bundle.js'){await route.fulfill({contentType:'application/javascript',body:bundle.outputFiles[0]!.text});return;}
   if(req.isNavigationRequest()){await route.fulfill({contentType:'text/html',body:`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/bundle.js"></script>`});return;}
   if(url.pathname.startsWith('/api/v1/loop-providers')){
    const response=await handler(request(url.pathname,req.method(),req.postData()?JSON.parse(req.postData()!):undefined,req.headers()['idempotency-key']??'provider-browser-read-0001'));
    await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});return;
   }
   unexpected.push(req.url());await route.abort();
  });
  await context.addInitScript(()=>{Object.defineProperty(navigator,'onLine',{get:()=>true,configurable:true});});
  context.setDefaultTimeout(20000);
  const page=await context.newPage();await page.goto('https://product.invalid');
  await expect(page.getByRole('heading',{name:'Providers',exact:true})).toBeVisible();
  await expect(page.locator('input[type=password]')).toHaveCount(0);
  await expect(page.getByLabel(/^Billing/).locator('option')).toHaveCount(2);
  await page.getByLabel('Provider ID',{exact:true}).fill('provider-one');
  await page.getByLabel('Provider name',{exact:true}).fill('Synthetic provider');
  await page.getByLabel('Base address',{exact:true}).fill('https://example.com/api');
  await page.getByLabel(/^Billing/).selectOption('token');
  await page.getByLabel('Reference launcher',{exact:true}).fill('synthetic-api');
  await page.getByLabel('Roster model',{exact:true}).fill('synthetic/model');
  await page.getByLabel('Model launcher',{exact:true}).fill('synthetic-api');
  await page.getByLabel('Served model ID',{exact:true}).fill('served/one');
  await page.getByLabel('Credit amount (nano-USD, blank means unknown)',{exact:true}).fill('123000');
  await page.getByLabel('Credit expiry',{exact:true}).fill('2027-01-31');
  await page.getByLabel('Credit note',{exact:true}).fill('Synthetic credit');
  await page.getByLabel('Price source address (optional)',{exact:true}).fill('https://example.com/prices');
  await page.getByRole('button',{name:'Save provider',exact:true}).click();
  await expect(page.getByRole('button',{name:'Edit Synthetic provider',exact:true})).toBeVisible();
  expect((await service.view(f.identity)).providers[0]!.models[0]!.served_model_id).toBe('served/one');
  await expect(page.getByText('Price: Unknown; checked at: Not checked',{exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Refresh prices',exact:true}).click();
  await expect(page.getByText(/Input 1234; output 2500 nano-USD per token/)).toBeVisible();
  await expect(page.locator('time')).toHaveText([new Date(now).toISOString(),new Date(now).toISOString()]);
  await expect(page.getByText(/Window: UTC, days 0, 6, 00:00–12:00/)).toBeVisible();
  await expect(page.getByText('Latest price fetch: ok',{exact:true})).toBeVisible();
  await f.db.query('UPDATE control_loop_provider_prices SET checked_at=$1',[new Date(now-24*3600_000-1).toISOString()]);
  failSource=true;await page.getByRole('button',{name:'Refresh prices',exact:true}).click();
  await expect(page.getByText(/Stale \(over 24 hours\)/)).toHaveCount(2);
  await expect(page.getByText('Latest price fetch: failed — fetch failure',{exact:true})).toBeVisible();
  await page.reload();await page.getByRole('button',{name:'Edit Synthetic provider',exact:true}).click();
  await page.getByLabel('Provider name',{exact:true}).fill('Replacement');
  await page.getByLabel(/^Credential reference/).selectOption('bitwarden');
  await page.getByLabel('Opaque item reference',{exact:true}).fill('opaque-item');
  await page.getByLabel('Served model ID',{exact:true}).fill('served/replacement');
  await page.getByRole('button',{name:'Save provider',exact:true}).click();
  await expect(page.getByRole('button',{name:'Remove Replacement',exact:true})).toBeVisible();
  expect((await service.view(f.identity)).providers[0]!.models[0]!.served_model_id).toBe('served/replacement');
  await page.reload();
  await page.getByRole('button',{name:'Edit Replacement',exact:true}).click();
  await expect(page.getByLabel('Opaque item reference',{exact:true})).toHaveValue('opaque-item');
  expect((await service.view(f.identity)).providers[0]!.secret_ref).toEqual({kind:'bitwarden',item:'opaque-item'});
  await expect(service.revalidate(f.identity,{providerId:'provider-one',model:'synthetic/model'})).rejects.toMatchObject({reason:'secret_missing'});
  await page.getByRole('button',{name:'Remove Replacement',exact:true}).click();
  await expect(page.getByText('Settings version 5',{exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Edit Replacement',exact:true})).toHaveCount(0);
  expect((await service.view(f.identity)).providers).toEqual([]);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  expect(unexpected).toEqual([]);
 }finally{await context?.close();await f.db.close();}
});

for(const width of [390,1280])test(`S3 all-provider choice saves non-cheapest credit and revalidates at ${width}px`,async({browser})=>{
 const f=await taskFixture();let context:Awaited<ReturnType<typeof browser.newContext>>|undefined;
 try{
  await f.db.query(`UPDATE projects SET payload=jsonb_set(payload,'{presentation}','{"templateId":"control-room"}'::jsonb)`);
  await f.db.query(`INSERT INTO control_loop_roster_models(tenant_id,name,position,launcher,provider,family,model_class,roles,efforts,default_effort,cost,on_off,note,nick,max_build_grade,updated_by,updated_at)
   VALUES('tenant:web','synthetic/model',1,'synthetic-api','','','','','','','','on','','','','identity:web',$1)`,[new Date(now).toISOString()]);
  const scope={tenantId:'tenant:web',workspaceId:'workspace:web'},service=new LoopProviderServiceV1(f.client,scope,{availability:async()=>{throw new Error('no credential probe');}},()=>now);
  for(const [i,id] of ['provider-one','provider-two','provider-three'].entries())await service.upsert(f.identity,id,{expectedVersion:i,provider:{provider_id:id,display_name:id,base_url:'https://example.com/api',billing_kind:'subscription',secret_ref:{kind:'launcher',launcher:'synthetic-api'},models:[{roster_name:'synthetic/model',launcher:'synthetic-api',served_model_id:`served/${id}`}],price_source_url:null,price_source_format:null,credit_amount_nano_usd:id==='provider-two'?'500000':null,credit_expires_on:'2020-01-01',credit_note:id==='provider-two'?'Recorded credit':'',}},`browser-s3-provider-${i}`);
  const price=async(id:string,input:string,output:string)=>f.db.query(`INSERT INTO control_loop_provider_prices VALUES('tenant:web',$1,$2,'all',NULL,$3,$4,'USD','known','',$5) ON CONFLICT (tenant_id,provider_id,model,window_key) DO UPDATE SET input_nano_usd_per_token=$3,output_nano_usd_per_token=$4`,[id,`served/${id}`,input,output,new Date(now).toISOString()]);
  await price('provider-one','10','20');await price('provider-two','30','40');
  const {LoopPolicyServiceV1}=await import('../../src/web/v1/loop-policy-service');
  const {createLoopPolicyHttpHandlerV1}=await import('../../src/web/v1/loop-policy-http');
  const policy=new LoopPolicyServiceV1(f.client,scope,{settingsText:'{}',checkSettings:async()=>({eligible:true,reasons:[]})},()=>now,service);
  await policy.put(f.identity,f.project.projectId,'selection',{expectedVersion:0,settings:'{"other":{"retained":true}}'},'browser-s3-initial-layer');
  const providerHttp=createLoopProviderHttpHandlerV1({origin,trust,service,clock:()=>now}),policyHttp=createLoopPolicyHttpHandlerV1({origin,trust,service:policy,clock:()=>now});
  const bundle=await build({write:false,bundle:true,platform:'browser',format:'iife',jsx:'automatic',stdin:{resolveDir:process.cwd(),loader:'tsx',contents:`import React from 'react';import {createRoot} from 'react-dom/client';import {ImprovementRunPanel} from './private-app/app/improvement-run-panel';createRoot(document.getElementById('root')).render(<ImprovementRunPanel projectId={${JSON.stringify(f.project.projectId)}} requests={[]} fresh={true}/>);`},plugins:[{name:'unused-legacy-crypto',setup(builder){
   builder.onResolve({filter:/^node:crypto$/},()=>({path:'node:crypto',namespace:'unused'}));
   builder.onLoad({filter:/.*/,namespace:'unused'},()=>({contents:'export function createHash(){throw new Error("unexercised_legacy_crypto")}',loader:'js'}));
  }}]});
  const css=await readFile('private-app/app/private.css','utf8'),unexpected:string[]=[];
  context=await browser.newContext({viewport:{width,height:900},isMobile:width<500,hasTouch:width<500});
  await context.route('**/*',async route=>{
   const req=route.request(),url=new URL(req.url());
   if(url.origin!=='https://product.invalid'){unexpected.push(req.url());await route.abort();return;}
   if(url.pathname==='/bundle.js'){await route.fulfill({contentType:'application/javascript',body:bundle.outputFiles[0]!.text});return;}
   if(req.isNavigationRequest()){await route.fulfill({contentType:'text/html',body:`<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script src="/bundle.js"></script>`});return;}
   const handler=url.pathname.includes('/loop-policy')?policyHttp:url.pathname.startsWith('/api/v1/loop-providers')?providerHttp:undefined;
   if(!handler){unexpected.push(req.url());await route.abort();return;}
   const response=await handler(request(url.pathname,req.method(),req.postData()?JSON.parse(req.postData()!):undefined,req.headers()['idempotency-key']??'browser-s3-read-00001'));
   await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:await response.text()});
  });
  await context.addInitScript(()=>{Object.defineProperty(navigator,'onLine',{get:()=>true,configurable:true});});
  context.setDefaultTimeout(20000);
  const page=await context.newPage();await page.goto('https://product.invalid');
  await expect(page.getByRole('heading',{name:'Provider choice',exact:true})).toBeVisible();
  await page.getByLabel('Routed roster model',{exact:true}).selectOption('synthetic/model');
  await expect(page.getByRole('radio')).toHaveCount(3);await expect(page.getByRole('radio',{checked:true})).toHaveCount(0);
  await expect(page.getByText('Cheapest',{exact:true})).toHaveCount(1);
  await expect(page.getByText(/Credit: 500000 nano-USD/)).toBeVisible();await expect(page.getByText(/expired/)).toHaveCount(3);
  await expect(page.getByText('Mapping valid; credential not re-checked.',{exact:true})).toHaveCount(3);
  await page.getByRole('radio',{name:'Choose provider-two',exact:true}).check();
  await page.evaluate(()=>Object.defineProperty(navigator,'onLine',{get:()=>false,configurable:true}));
  await page.getByRole('button',{name:'Save provider choice',exact:true}).click();
  await expect(page.getByText('Offline. Reconnect before saving the provider choice.',{exact:true})).toBeVisible();
  expect((await policy.view(f.identity,f.project.projectId)).selection.version).toBe(1);
  await page.evaluate(()=>Object.defineProperty(navigator,'onLine',{get:()=>true,configurable:true}));
  await page.getByRole('button',{name:'Save provider choice',exact:true}).click();
  await expect(page.getByText('Provider choice saved',{exact:true})).toBeVisible();
  await page.reload();await expect(page.getByRole('radio',{name:'Choose provider-two',exact:true})).toBeChecked();
  await page.screenshot({path:`test-results/s3-provider-choice-${width}.png`,fullPage:true});
  const layer=JSON.parse((await policy.view(f.identity,f.project.projectId)).selection.settingsText);
  expect(layer).toEqual({other:{retained:true},providerRoute:{providerId:'provider-two',model:'synthetic/model'}});
  await price('provider-two','10','20');await page.getByRole('button',{name:'Reload provider choices',exact:true}).click();await expect(page.getByText('Cheapest',{exact:true})).toHaveCount(2);
  await price('provider-two','5','30');await page.getByRole('button',{name:'Reload provider choices',exact:true}).click();await expect(page.getByText('No single cheapest',{exact:true})).toBeVisible();
  await service.remove(f.identity,'provider-two',{expectedVersion:3},'browser-s3-remove-key');
  await page.reload();await expect(page.getByText('Provider removed',{exact:true})).toBeVisible();await expect(page.getByRole('radio')).toHaveCount(2);
  await expect(page.getByRole('radio',{checked:true})).toHaveCount(0);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);expect(unexpected).toEqual([]);
 }finally{await context?.close();await f.db.close();}
});
