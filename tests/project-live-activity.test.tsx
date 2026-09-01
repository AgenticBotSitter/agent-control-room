import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProjectLiveActivity } from "../app/components/project-live-activity.tsx";

test("CR13A-LIVE-000 live project activity renders a clear read-only connection boundary",()=>{
  const html=renderToStaticMarkup(<ProjectLiveActivity projectId="project:events"/>);
  assert.match(html,/Live project activity/);assert.match(html,/Protected live source/);assert.match(html,/Connecting/);
  assert.match(html,/Reconnect never approves, dispatches, retries work, or changes project truth/);
  assert.match(html,/Waiting for authenticated project events/);assert.doesNotMatch(html,/Approve|Dispatch work|Retry work/);
});
