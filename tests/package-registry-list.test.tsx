import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PackageRegistryList } from "../app/components/package-registry-list";
import { cr7ePackageRegistryFixture } from "../app/fixtures/cr7e-ui";

test("CR7E registry UI distinguishes reviewed, candidate, and rejected versions without an authority control", () => {
  const html=renderToStaticMarkup(<PackageRegistryList packages={cr7ePackageRegistryFixture}/>);
  assert.match(html,/Procedure and knowledge registry/); assert.match(html,/build-and-check/); assert.match(html,/v1.0.0/); assert.match(html,/v2.0.0/); assert.match(html,/Rejected/);
  assert.match(html,/never supply policy, approval, dispatch, credentials, or execution authority/);
  assert.doesNotMatch(html,/<button/); assert.doesNotMatch(html,/private key|Bearer |credential:/i);
});

test("CR7E registry UI has an explicit empty state",()=>{
  assert.match(renderToStaticMarkup(<PackageRegistryList packages={[]}/>),/No package versions are visible/);
});
