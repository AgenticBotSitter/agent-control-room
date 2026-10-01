#!/usr/bin/env node
import { pathToFileURL } from "node:url";

function refuse(message) {
  throw new Error(message);
}

function valueAfter(args, index) {
  if (index + 1 >= args.length || args[index + 1] === "") refuse(`missing value for ${args[index]}`);
  return args[index + 1];
}

function validPort(value, label) {
  if (!/^[0-9]+$/u.test(value) || Number(value) < 1 || Number(value) > 65_535) {
    refuse(`${label} must be from 1 to 65535`);
  }
  return Number(value);
}

function validTag(value, label) {
  if (!/^tag:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(value)) {
    refuse(`${label} must be a plain tag name`);
  }
  return value;
}

export function parseArguments(args) {
  const options = {
    vpsTag: "tag:control-room-vps",
    clientTag: "tag:control-room-client",
    generalTag: "tag:general",
    johnny5: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    switch (args[index]) {
      case "--front-door-port": options.frontDoorPort = validPort(valueAfter(args, index), args[index]); index += 1; break;
      case "--web-port": options.webPort = validPort(valueAfter(args, index), args[index]); index += 1; break;
      case "--gateway-port": options.gatewayPort = validPort(valueAfter(args, index), args[index]); index += 1; break;
      case "--vps-tag": options.vpsTag = validTag(valueAfter(args, index), args[index]); index += 1; break;
      case "--client-tag": options.clientTag = validTag(valueAfter(args, index), args[index]); index += 1; break;
      case "--general-tag": options.generalTag = validTag(valueAfter(args, index), args[index]); index += 1; break;
      case "--johnny5": options.johnny5 = true; break;
      case "--help": options.help = true; break;
      default: refuse(`unknown argument: ${args[index]}`);
    }
  }
  if (options.help) return options;
  for (const key of ["frontDoorPort", "webPort", "gatewayPort"]) {
    if (options[key] === undefined) refuse(`missing --${key.replace(/[A-Z]/gu, value => `-${value.toLowerCase()}`)}`);
  }
  const ports = [options.frontDoorPort, options.webPort, options.gatewayPort];
  if (new Set(ports).size !== ports.length) refuse("front-door, web, and gateway ports must be distinct");
  if (ports.some(port => [22, 443, 5432].includes(port))) {
    refuse("generated ports must not collide with the explicit deny ports 22, 443, or 5432");
  }
  return Object.freeze(options);
}

export function renderPolicy(options) {
  const accept = [`${options.clientTag}:${options.frontDoorPort}`];
  const denyClient = [
    `${options.clientTag}:22`,
    ...(options.johnny5 ? [] : [`${options.clientTag}:443`]),
    `${options.clientTag}:${options.webPort}`,
    `${options.clientTag}:${options.gatewayPort}`,
    `${options.clientTag}:5432`,
    `${options.generalTag}:22`,
  ];
  const grants = [
    `  { "src": [${JSON.stringify(options.vpsTag)}], "dst": [${JSON.stringify(options.clientTag)}], "ip": [${JSON.stringify(`tcp:${options.frontDoorPort}`)}] },`,
    ...(options.johnny5 ? [`  { "src": [${JSON.stringify(options.vpsTag)}], "dst": [${JSON.stringify(options.clientTag)}], "ip": ["tcp:443"] },`] : []),
  ];
  return `// Merge these entries into the matching top-level HuJSON objects and arrays.\n` +
`"tagOwners": {\n` +
`  ${JSON.stringify(options.vpsTag)}: ["autogroup:admin"],\n` +
`},\n` +
`"grants": [\n${grants.join("\n")}\n],\n` +
`"tests": [\n` +
`  { "src": ${JSON.stringify(options.vpsTag)},\n` +
`    "accept": ${JSON.stringify(accept)},\n` +
`    "deny": ${JSON.stringify(denyClient)} },\n` +
`  { "src": ${JSON.stringify(options.clientTag)},\n` +
`    "deny": [${JSON.stringify(`${options.vpsTag}:22`)}, ${JSON.stringify(`${options.vpsTag}:5432`)}, ${JSON.stringify(`${options.vpsTag}:443`)}] },\n` +
`  { "src": ${JSON.stringify(options.generalTag)},\n` +
`    "deny": [${JSON.stringify(`${options.vpsTag}:22`)}, ${JSON.stringify(`${options.vpsTag}:5432`)}] },\n` +
`],\n` +
`"sshTests": [\n` +
`  { "src": ${JSON.stringify(options.clientTag)}, "dst": [${JSON.stringify(options.vpsTag)}], "deny": ["root", "autogroup:nonroot"] },\n` +
`],\n`;
}

export function main(args = process.argv.slice(2)) {
  try {
    const options = parseArguments(args);
    if (options.help) {
      console.log("Usage: tailnet-policy-snippet.mjs --front-door-port PORT --web-port PORT --gateway-port PORT [--johnny5] [--vps-tag TAG --client-tag TAG --general-tag TAG]");
      return 0;
    }
    process.stdout.write(renderPolicy(options));
    return 0;
  } catch (error) {
    console.error(`tailnet policy error: ${error instanceof Error ? error.message : "invalid input"}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
