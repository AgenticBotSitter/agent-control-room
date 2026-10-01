import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { UpdaterHomeStatus } from "../../private-app/app/updater-home-status";
import { updaterOwnerUiReadSchemaV1 } from "../../src/web/v1/updater-owner-ui-wire";

const encoded = process.argv[2];
if (!encoded || encoded.length > 32_768) throw new Error("rehearsal_owner_ui_input_refused");
const value = updaterOwnerUiReadSchemaV1.parse(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")));
const dom = new JSDOM("<div id=root></div>", { url: "https://rehearsal.invalid/", pretendToBeVisual: true });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, IS_REACT_ACT_ENVIRONMENT: true,
  fetch: async () => Response.json(value) });
const container = dom.window.document.getElementById("root")!, root = createRoot(container);
let result = { text: "", html: "" };
await import("react").then(async React => {
  await React.act(async () => { root.render(createElement(UpdaterHomeStatus)); });
  for (let attempt = 0; attempt < 20; attempt += 1)
    await React.act(async () => { await new Promise(resolve => dom.window.setTimeout(resolve, 5)); });
  result = { text: container.textContent ?? "", html: container.innerHTML };
  await React.act(async () => { root.unmount(); });
});
dom.window.close();
process.stdout.write(`${JSON.stringify(result)}\n`);
