// Read-only actual local artifact inventory; no package execution or legal clearance.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ts from 'typescript';
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const pkg=JSON.parse(fs.readFileSync('package.json'));
const draft=fs.readFileSync('docs/research/DEPENDENCY_NOTICES_DRAFT.txt','utf8');
const files=[];function walk(dir){for(const d of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,d.name);if(d.isSymbolicLink())continue;if(d.isDirectory())walk(p);else files.push(p);}}walk('dist-vps');
const modules=[],licenseComments=[],inventory=[];
for(const p of files.sort()){const b=fs.readFileSync(p);inventory.push({path:p,bytes:b.length,sha256:hash(b)});if(!p.endsWith('.js'))continue;const source=b.toString();const ast=ts.createSourceFile(p,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);function visit(n){let spec;if(ts.isImportDeclaration(n)||ts.isExportDeclaration(n))spec=n.moduleSpecifier;else if(ts.isCallExpression(n)&&(n.expression.kind===ts.SyntaxKind.ImportKeyword||n.expression.getText(ast)==='require'))spec=n.arguments[0];if(spec&&ts.isStringLiteral(spec)&&!spec.text.startsWith('.')&&!spec.text.startsWith('/'))modules.push({file:p,specifier:spec.text});ts.forEachChild(n,visit);}visit(ast);if(/@license|@preserve|copyright|license/i.test(source))licenseComments.push(p);}
console.log(JSON.stringify({scope:'current local dist-vps only; no build provenance freshness or complete embedded module identification',lockSha256:hash(fs.readFileSync('pnpm-lock.yaml')),direct:Object.entries({...pkg.dependencies,...pkg.devDependencies}).map(([name,spec])=>({name,spec,mentionedInOldDraft:draft.includes(name)})),fileCount:files.length,totalBytes:inventory.reduce((n,x)=>n+x.bytes,0),noticeNamedFiles:files.filter(p=>/license|notice/i.test(path.basename(p))),bareSpecifiers:[...new Set(modules.map(x=>x.specifier))].sort(),licenseTextMentionFiles:licenseComments,inventory},null,2));
