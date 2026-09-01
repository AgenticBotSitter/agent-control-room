import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ConnectionCenterPanel } from "../app/components/connection-center.tsx";
import { buildConnectionCenterProjectionV1 } from "../src/connection-center/v1/index.ts";
import { buildIdeaLabHermes021ConnectionRosterV1 } from "../src/idea-lab/v1/index.ts";

test("CR13A-LIVE-010 renders the protected empty state without inventing a connection", () => {
  const projection = buildConnectionCenterProjectionV1(buildIdeaLabHermes021ConnectionRosterV1({
    tenantId: "tenant:owner", evaluatedAt: "2026-09-01T18:00:00.000Z", connections: [],
  }));
  const html = renderToStaticMarkup(<ConnectionCenterPanel data={{ state: "available", projection }} />);
  assert.match(html, /No enrolled connections yet/);
  assert.match(html, /Hermes 0\.21/);
  assert.match(html, /Read only · no connect action/);
  assert.match(html, /cannot open SSH, read credentials, start Hermes, contact a provider, approve work, dispatch, or execute/);
  assert.doesNotMatch(html, /Connect now|Start Hermes|Run qualification/);
});

test("CR13A-LIVE-010 never substitutes fixtures when the protected route is unavailable", () => {
  const html = renderToStaticMarkup(<ConnectionCenterPanel data={{ state: "unavailable", code: "authentication_required" }} />);
  assert.match(html, /Protected connection inventory unavailable/);
  assert.match(html, /No fixture connection, hostname, credential, or live status is substituted/);
});
