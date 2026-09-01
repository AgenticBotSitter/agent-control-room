import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { IdeaLabOperatorControls } from "../app/components/idea-lab-operator-controls.tsx";
test("CR12B-IDEA-040 shipped controls clearly report the disabled protected runtime",()=>{const html=renderToStaticMarkup(<IdeaLabOperatorControls/>);assert.match(html,/Protected runtime not configured/);assert.equal((html.match(/disabled=""/g)??[]).length,9);assert.doesNotMatch(html,/provider connected|project created successfully/i);});
test("CR12B-IDEA-040 configured presentation exposes separate create, run, synthesize, cancel, save, and promote controls",()=>{const html=renderToStaticMarkup(<IdeaLabOperatorControls enabled/>);for(const label of["Create session","Run bounded panel","Synthesize","Cancel","Save idea","Create monitored project"])assert.match(html,new RegExp(`>${label}<`));assert.match(html,/Creating the session, running the panel, synthesizing advice, and making the owner decision are separate recorded steps/);});
