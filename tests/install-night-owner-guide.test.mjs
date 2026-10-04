import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { makeOwnerPasteFile } from "../scripts/install/make-owner-paste-file.mjs";

const guide = readFileSync(fileURLToPath(new URL("../docs/INSTALL_NIGHT_OWNER_GUIDE.md", import.meta.url)), "utf8");

test("R5G guide install calls match the generated guards and stop a hand-copied block", async () => {
  const kit = readFileSync(new URL("../docs/install/E2E2_REHEARSAL.md", import.meta.url), "utf8");
  const generated = await makeOwnerPasteFile({ releaseCommit: "a".repeat(40), stagingFolder: "/neutral/stage",
    livePorts: [4100], liveLabelPrefixes: ["neutral.live."], rehearsalTailnetName: "practice.rehearsal.example",
    repoSlug: "example/control-room" });
  for (const [document, name, number] of [[guide, "live_install_step", 11], [kit, "install_step", 7]]) {
    const code = [...document.matchAll(/```sh\n([\s\S]*?)```/gu)].map(match => match[1])
      .find(block => block.startsWith(`${name}() {`));
    assert.ok(code, `missing ${name} guide block`);
    const invocation = code.trimEnd().split("\n").at(-1);
    assert.equal(invocation, `${name} || return 1`);
    const generatedBlock = generated.split(`paste_block_${number}() {\n`)[1].split(`\npaste_block_${number}\n`)[0];
    assert.ok(generatedBlock.split("\n").includes(invocation), "guide and generator must agree");
    for (const status of [0, 1]) {
      // Use the actual copied invocation with a harmless install stand-in.
      const output = execFileSync("/bin/zsh", ["-c", `copied_block() {\n${name}() { return ${status}; }\n${invocation}\nprint continued\n}\ncopied_block\nprint result-$?`],
        { encoding: "utf8", timeout: 2000 });
      assert.equal(output, status === 0 ? "continued\nresult-0\n" : "result-1\n");
    }
  }
  for (const [number, description] of [[4, "Generate the isolated rehearsal identity"], [7, "Practice the install"]]) {
    assert.ok(kit.includes(`Paste block ${number}, “${description}”`));
    assert.ok(generated.includes(`: '${number}. ${description};`), "rehearsal numbering must match generated labels");
  }
  assert.match(kit, /PASS table in step 8/u);
  assert.match(generated, /: '8\. Collect the practice evidence;/u);
});

test("install-night owner guide covers the owner prompts and recovery", () => {
  assert.match(guide, /six words/u);
  assert.match(guide, /three tries/u);
  assert.match(guide, /type the six words it shows; you get three tries/u);
  assert.match(guide, /scan the (terminal )?QR code/iu);
  assert.match(guide, /six-character code/u);
  assert.match(guide, /passkey add/u);
  assert.match(guide, /selects add mode/u);
  assert.match(guide, /inactive for 24 hours/u);
  assert.match(guide, /saves the token in your password manager/u);
  assert.doesNotMatch(guide, /clipboard/iu);
  assert.match(guide, /quit the Claude app and the ChatGPT app \(Cmd-Q\)/u);
  assert.match(guide, /The lead is not available from here until the installer prints Ready \(or rolls back\)/u);
  assert.match(guide, /do not retry, copy the last lines/u);
  const window = guide.split('## After install: connect your bots')[0];
  assert.doesNotMatch(window, /same install line again|tell the lead/u);
  for (const line of window.split('\n').filter(line => /STOP:|^\|/.test(line))) {
    if (/show.*lead/.test(line)) assert.match(line, /after reopening Claude/u);
  }
  assert.match(guide, /system diff is empty/u);
  assert.match(guide, /Practice passkey registered\. No phone was used\./u);
  assert.match(guide, /you need no phone and do not approve Face ID or type a code/u);
  assert.match(guide, /Practice passkey did not register.*stop and show the lead after reopening Claude/u);
  assert.match(guide, /The rehearsal never changes Tailscale, and your phone keeps working during it\./u);
  assert.match(guide, /:443.*moves from the old Control Room.*7864.*new Control Room.*3210/su);
  assert.match(guide, /:8443.*stays on port 3310/u);
  assert.match(guide, /one paste file/u);
  assert.match(guide, /normal account/u);
  assert.match(guide, /Pause all bots/u);
  assert.match(guide, /your Mac password is typed only after every bot has stopped/u);
  // Four families: OpenCode holds a working directory and an API key like the
  // others, so pausing the bots includes it (r5sfix).
  assert.match(guide, /no codex\/claude\/hermes\/opencode worker processes under the owner's uid/u);
  // r5sdeny's check denies by default and lists Node/Python wrappers, so the guide
  // must no longer warn that they can be missed (the owner guides take r5sdeny's wording).
  assert.doesNotMatch(guide, /Node\/Python wrappers can be missed/u);
  assert.match(guide, /Apple silicon Mac/u);
  assert.match(guide, /bootstrap_platform_refused/u);
  assert.match(guide, /Quit Image Lab and ComfyUI/u);
  const botCheck = readFileSync(new URL("../scripts/install/rehearsal/check-bots-stopped.mjs", import.meta.url), "utf8");
  assert.ok(botCheck.includes("STOP: bot worker processes are still running under the owner's uid:"));
  assert.ok(guide.includes("STOP: bot worker processes are still running under the owner's uid:"));
  assert.match(guide, /sudo \/usr\/local\/bin\/control-room rescue/u);
  assert.match(guide, /sudo \/usr\/local\/bin\/control-room check-and-continue/u);
  assert.match(guide, /guard_refused:no_older_pair/u);
  assert.match(guide, /current service state was not checked/u);
  assert.doesNotMatch(guide, /Your current version keeps running/u);
  assert.doesNotMatch(guide, /fresh macOS administrator account/iu);
  assert.doesNotMatch(guide, /two accounts/iu);
  assert.match(guide, /fresh database.*does not copy the old Control Room's data/su);
  assert.match(guide, /live_install_step/u);
  assert.match(guide, /mktemp -d \/var\/root\/cr-boot\.XXXXXX/u);
  assert.doesNotMatch(guide, /TODO for the lead/u);
});

test("install-night owner guide has no configured private name", () => {
  const privateName = process.env.CONTROL_ROOM_PRIVATE_NAMES;
  if (!privateName) return;
  for (const term of privateName.split(/\r?\n/u).map(value => value.trim()).filter(Boolean)) {
    assert.doesNotMatch(guide, new RegExp(term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "iu"));
  }
});

test("post-install instructions match the existing connector and task controls", () => {
  const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const connect = read("private-app/app/workers/connect/connect-bot-workspace.tsx");
  const catalog = read("src/fleet/v1/catalog.ts");
  const fleet = read("private-app/app/workers/fleet-workers.tsx");
  const statusLabels = read("private-app/app/owner-status-labels.ts");
  const offer = read("private-app/app/workers/fleet-offer.tsx");
  const section = guide.split("## After install: connect your bots")[1]?.split("## After an upgrade:")[0];
  assert.ok(section);
  for (const label of ["Name for this bot", "Create code", "Copy line", "Let this bot pick up approved work on its own", "Profile", "Model", "Provider", "Connected bots"]) {
    assert.ok(connect.includes(label), `page lacks ${label}`);
    assert.ok(section.includes(label), `guide lacks ${label}`);
  }
  for (const label of ["Codex", "Claude Code", "Hermes", "Writing"]) {
    assert.ok(catalog.includes(`label: "${label}"`));
    assert.ok(section.includes(label));
  }
  for (const label of ["Connected", "Working", "Last seen", "Read the result", "Accept", "Ask for changes", "Reject"]) {
    if (label === "Connected" || label === "Working") {
      const state = label.toLowerCase();
      assert.ok(fleet.includes(`ownerStatusLabels.fleet.${state}`));
      assert.ok(statusLabels.includes(`${state}: "${label}"`));
    } else assert.ok(fleet.includes(label));
    assert.ok(section.includes(label));
  }
  assert.ok(fleet.includes('href="/workers/connect"'));
  for (const label of ["Skill needed", "Offer to other machines", "Who can take it", "Choose bots", "Any connected bot"]) {
    assert.ok(offer.includes(label));
    assert.ok(section.includes(label));
  }
  assert.match(section, /Offering is your permission/u);
  assert.match(section, /Choose bots/u);
  assert.match(section, /Any connected bot/u);
  assert.doesNotMatch(section, /Choose a specific bot|Any bot instead/u,
    "the guide must not describe the single-bot picker offerui replaced");
  assert.doesNotMatch(section, /There is no bot picker/u,
    "the guide must not still deny the picker the product now offers");
  assert.match(section, /Stopped.*while connecting/su);
  assert.match(section, /off by default/iu);
  assert.match(section, /single-use enrollment codes/u);
  assert.doesNotMatch(section, /task-runtime\.json|enable-installed-tasks|sudo|```sh/u);
  // Flags described by the existing contract must be consumed by the real CLI,
  // including the Hermes selections that the page's server-built line emits.
  const cli = read("scripts/fleet/connector.mjs");
  const parser = cli.slice(cli.indexOf("function options(args)"), cli.indexOf("const usage ="));
  const main = cli.slice(cli.indexOf("export async function main("));
  const commandBuilder = read("src/web/v1/fleet-owner-http.ts").split("export function fleetJoinCommandsV1")[1].split("export function createFleetOwnerHttpHandlerV1")[0];
  const flags = [...commandBuilder.matchAll(/ --([a-z-]+)/gu)].map(match => match[1]);
  assert.ok(flags.length > 0);
  for (const flag of new Set(flags)) {
    assert.ok(parser.includes(`"${flag}"`) || main.includes(`values.${flag}`) || main.includes(`values["${flag}"]`), `CLI does not consume ${flag}`);
  }
});


test("R5G guide uses actual sign-in, distinguishes health from Face ID, and corrects legacy wording", () => {
  assert.match(guide, /phone does not sign in your Mac browser/u);
  assert.match(guide, /after `#code=` and before `&reg=`/u);
  assert.match(guide, /into \*\*Owner code\*\*.*\*\*Sign in\*\*/u);
  assert.match(guide, /initial mode only when no passkey has ever been recorded/u);
  assert.match(guide, /even a revoked one/u);
  assert.match(guide, /unreadable key list stops/u);
  assert.match(guide, /Local worker evidence/u);
  assert.doesNotMatch(guide, /Home is the proof|confirm it says Control Room is healthy|successful Face ID sign-in/u);
  assert.match(guide, /no separate read-only Face ID test/u);
  const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const kit = read("docs/install/E2E2_REHEARSAL.md"), legacy = read("docs/OWNER_GUIDE_MAC.md");
  assert.match(kit, /Paste block 4, “Generate the isolated rehearsal identity”/u);
  assert.match(kit, /PASS table in step 8/u);
  assert.ok(kit.indexOf("4. all three health") < kit.indexOf("5. the Face ID step"));
  assert.match(legacy, /legacy remote-database route/u);
  assert.doesNotMatch(legacy, /--ssh-target|mac:check-database -- </u);
  assert.match(legacy, /Prints three lines/u);
  assert.match(legacy, /Accepting that result is a separate owner decision/u);
  assert.match(legacy, /six lines, one per role.*least privilege: ok/u);
});
