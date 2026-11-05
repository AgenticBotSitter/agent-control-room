import assert from "node:assert/strict";
import test from "node:test";

// The Home card is an optional capability: a host without the loop candidate
// feature answers 404 once, and the page must then never ask again.
async function mount(respond: (path: string) => Response) {
  const React = await import("react"), { act } = React, { createRoot } = await import("react-dom/client");
  const { JSDOM } = await import("jsdom");
  const { ImprovementFinishCard } = await import("../private-app/app/improvement-finish-card");
  const dom = new JSDOM("<div id='root'></div>", { url: "https://product.invalid/", pretendToBeVisual: true });
  const paths: string[] = [];
  const transport: typeof fetch = async input => { paths.push(new URL(String(input), "https://product.invalid").pathname); return respond(paths.at(-1)!); };
  const globals = { window: dom.window, document: dom.window.document, navigator: dom.window.navigator, fetch: transport, IS_REACT_ACT_ENVIRONMENT: true };
  const saved = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const);
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  const root = createRoot(dom.window.document.getElementById("root")!);
  const settle = async () => { for (let i = 0; i < 8; i++) await act(async () => { await new Promise(r => setTimeout(r, 10)); }); };
  await act(async () => root.render(React.createElement(ImprovementFinishCard)));
  await settle();
  return { dom, paths, settle, act, close: async () => { await act(async () => root.unmount());
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else delete (globalThis as Record<string, unknown>)[key]; } } };
}

test("configured host: Home card reads, renders and keeps polling on demand", async () => {
  const page = () => Response.json({ schemaVersion: 1, candidates: [], truncated: false, observedAt: new Date().toISOString(),
    startsDeploy: false, signedDeployApprovalCreated: false });
  const m = await mount(page);
  try {
    assert.deepEqual(m.paths, ["/api/v1/loop-update-candidates"]);
    assert.match(m.dom.window.document.body.textContent!, /No verified candidate is recorded/);
    const refresh = [...m.dom.window.document.querySelectorAll("button")].find(b => b.textContent === "Refresh candidate")!;
    await m.act(async () => refresh.click()); await m.settle();
    assert.equal(m.paths.length, 2, "configured host still reads again");
  } finally { await m.close(); }
});

test("absent host: exactly one request on 404, nothing rendered, no polling", async () => {
  const m = await mount(() => Response.json({}, { status: 404 }));
  try {
    assert.deepEqual(m.paths, ["/api/v1/loop-update-candidates"]);
    assert.equal(m.dom.window.document.querySelector("section"), null);
    m.dom.window.dispatchEvent(new m.dom.window.Event("focus"));
    m.dom.window.document.dispatchEvent(new m.dom.window.Event("visibilitychange"));
    await m.settle();
    assert.equal(m.paths.length, 1, "no re-request after the tolerated 404");
  } finally { await m.close(); }
  // A later mount in the same page lifetime does not probe again.
  const again = await mount(() => Response.json({}, { status: 404 }));
  try { assert.equal(again.paths.length, 0, "remount never re-requests"); } finally { await again.close(); }
});
