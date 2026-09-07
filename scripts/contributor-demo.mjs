import { fileURLToPath } from "node:url";
import { createContributorDemoApplication } from "../src/contributor-demo/application.ts";
import { createContributorDemoService } from "../src/web/v1/private-serving.ts";
import { launchContributorDemo } from "../src/contributor-demo/launcher.ts";

// This entry point is run only by the explicit demo command, never by a build.
await launchContributorDemo(async () => {
  const app = await createContributorDemoApplication(fileURLToPath(new URL("../", import.meta.url)));
  try { return { ...createContributorDemoService(app), ownerCode: app.ownerCode }; }
  catch (error) { await app.close(); throw error; }
}, {
  on: (signal, handler) => { process.on(signal, handler); },
  off: (signal, handler) => { process.off(signal, handler); },
  output: message => console.log(message),
  error: message => console.error(message),
  exitCode: code => { process.exitCode = code; },
});
