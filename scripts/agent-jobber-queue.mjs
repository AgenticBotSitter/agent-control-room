#!/usr/bin/env node

import { readFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

const ROUTE = /^[a-z0-9][a-z0-9._-]{1,47}$/;
const CAPSULE_PATH = /^coordination\/agent-build\/capsules\/[A-Z0-9][A-Z0-9._-]{2,63}\.json$/;
const INTEGRATION_BRANCH = /^integration\/[a-z0-9][a-z0-9._/-]*$/;
const TRUSTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
const LABELS = {
  ready: ["jobber-ready", "2da44e", "V2 capsule is ready for an eligible route"],
  claimed: ["jobber-claimed", "bf8700", "V2 capsule has an active route claim"],
  review: ["jobber-review", "0969da", "Submitted V2 result awaits intake or review"],
  help: ["jobber-needs-help", "cf222e", "Blocked V2 capsule requires Codex triage"]
};

export function parseJobberCommand(value) {
  const text = value.trim();
  let match = /^\/claim\s+([a-z0-9][a-z0-9._-]{1,47})$/.exec(text);
  if (match) return { action: "claim", route: match[1] };
  match = /^\/release\s+([a-z0-9][a-z0-9._-]{1,47})\s+--no-work-started\s+(.{1,300})$/s.exec(text);
  if (match) return { action: "release", route: match[1], reason: oneLine(match[2]) };
  match = /^\/blocked\s+([a-z0-9][a-z0-9._-]{1,47})\s+(.{1,300})$/s.exec(text);
  if (match) return { action: "blocked", route: match[1], reason: oneLine(match[2]) };
  match = /^\/submitted\s+([a-z0-9][a-z0-9._-]{1,47})\s+(https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9][0-9]*)$/.exec(text);
  if (match) return { action: "submitted", route: match[1], pullUrl: match[2] };
  return null;
}

function oneLine(value) {
  return value.replace(/\s+/g, " ").trim();
}

export function issueMarkers(body) {
  const capsule = /^Capsule:\s*`([^`]+)`\s*$/m.exec(body ?? "")?.[1];
  const integration = /^Integration:\s*`([^`]+)`\s*$/m.exec(body ?? "")?.[1];
  if (!CAPSULE_PATH.test(capsule ?? "") || !INTEGRATION_BRANCH.test(integration ?? "")) return null;
  return { capsule, integration };
}

export function producerBranch(capsuleId, route) {
  return `agent/${route}/${capsuleId.toLowerCase()}`;
}

export function jobberTitle(state, capsule, route) {
  const tier = capsule.taskClass.split("-")[0].toUpperCase();
  const stateLabel = route && state === "CLAIMED" ? `CLAIMED:${route}` : state;
  return `[${stateLabel}][${capsule.platform.toUpperCase()}][${tier}][${capsule.block}][${capsule.capsuleId}] ${capsule.summary}`.slice(0, 256);
}

function labelsOf(issue) {
  return new Set((issue.labels ?? []).map((label) => typeof label === "string" ? label : label.name));
}

function routeLabel(route) {
  return `route:${route}`;
}

export function pullNumber(url, repository) {
  const escaped = repository.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return Number(new RegExp(`^https://github\\.com/${escaped}/pull/([1-9][0-9]*)$`).exec(url)?.[1] ?? 0);
}

function decodeContent(response) {
  if (response?.type !== "file" || response.encoding !== "base64") throw new Error("repository content response was not a base64 file");
  return Buffer.from(response.content.replace(/\s/g, ""), "base64").toString("utf8");
}

function createApi(repository, token) {
  const apiOrigin = process.env.AGENT_JOBBER_API_ORIGIN ?? "https://api.github.com";
  const origin = `${apiOrigin.replace(/\/$/, "")}/repos/${repository}`;
  return async (method, endpoint, body, allow404 = false) => {
    const response = await fetch(`${origin}${endpoint}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "control-room-agent-jobber-v2"
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (allow404 && response.status === 404) return null;
    if (!response.ok) throw new Error(`GitHub API ${method} ${endpoint} returned ${response.status}`);
    if (response.status === 204) return null;
    return response.json();
  };
}

async function ensureLabel(api, [name, color, description]) {
  const encoded = encodeURIComponent(name);
  if (await api("GET", `/labels/${encoded}`, undefined, true)) return;
  await api("POST", "/labels", { name, color, description });
}

async function comment(api, issueNumber, body) {
  await api("POST", `/issues/${issueNumber}/comments`, { body });
}

async function transitionIssue(api, issue, { title, add = [], remove = [], addAssignee, removeAssignee }) {
  const labels = labelsOf(issue);
  for (const name of remove) labels.delete(name);
  for (const name of add) labels.add(name);
  const assignees = new Set((issue.assignees ?? []).map((assignee) => assignee.login));
  if (removeAssignee) assignees.delete(removeAssignee);
  if (addAssignee) assignees.add(addAssignee);
  await api("PATCH", `/issues/${issue.number}`, { title, labels: [...labels].sort(), assignees: [...assignees].sort() });
}

async function repositoryJson(api, file, ref, allow404 = false) {
  const encodedPath = file.split("/").map(encodeURIComponent).join("/");
  const response = await api("GET", `/contents/${encodedPath}?ref=${encodeURIComponent(ref)}`, undefined, allow404);
  if (response === null) return null;
  return JSON.parse(decodeContent(response));
}

function validateCapsuleForClaim(capsule, markers, login, route) {
  const errors = [];
  if (!ROUTE.test(route)) errors.push("route identifier is invalid");
  if (capsule?.schema !== "control-room.agent-build-capsule/v2") errors.push("capsule schema is not V2");
  if (capsule?.status !== "ready") errors.push("capsule status is not ready");
  if (capsule?.integrationBranch !== markers.integration) errors.push("issue integration marker differs from capsule");
  if (!/^[A-Z0-9][A-Z0-9._-]{2,63}$/.test(capsule?.capsuleId ?? "")) errors.push("capsule ID is invalid");
  if (typeof capsule?.summary !== "string" || capsule.summary.length < 1 || capsule.summary.length > 100) errors.push("capsule summary is invalid");
  if (!["any", "macos", "windows", "linux"].includes(capsule?.platform)) errors.push("capsule platform is invalid");
  if (!/^T[0-3]-/.test(capsule?.taskClass ?? "")) errors.push("capsule task class is invalid");
  if (typeof capsule?.block !== "string" || capsule.block.length === 0) errors.push("capsule block is invalid");
  if (!Array.isArray(capsule?.dependencies)) errors.push("capsule dependencies are invalid");
  if (!capsule?.eligibleRoutes?.includes(route)) errors.push("route is not eligible");
  const claimants = capsule?.routeClaimants?.[route] ?? [];
  if (!claimants.some((claimant) => claimant.toLowerCase() === login.toLowerCase())) errors.push("GitHub identity is not authorized for route");
  if (!Number.isInteger(capsule?.maxConcurrentClaimsPerRoute) || capsule.maxConcurrentClaimsPerRoute < 1) errors.push("capsule claim limit is invalid");
  return errors;
}

async function claim({ api, issue, capsule, markers, command, login, repository }) {
  const labels = labelsOf(issue);
  const errors = validateCapsuleForClaim(capsule, markers, login, command.route);
  if (errors.length > 0) throw new Error(errors.join("; "));
  if (!labels.has(LABELS.ready[0]) || labels.has(LABELS.claimed[0]) || labels.has(LABELS.review[0]) || labels.has(LABELS.help[0])) errors.push("issue is not in the ready state");
  if (issue.title !== jobberTitle("READY", capsule)) errors.push("issue title does not match the capsule's ready title");
  for (const dependency of capsule.dependencies ?? []) {
    const result = await repositoryJson(api, `coordination/agent-build/results/${dependency}.json`, markers.integration, true);
    if (result === null) errors.push(`dependency is not integrated: ${dependency}`);
  }
  const branch = producerBranch(capsule.capsuleId, command.route);
  const branchRef = await api("GET", `/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`, undefined, true);
  if (branchRef !== null) errors.push("producer branch already exists; request Codex triage");
  if (errors.length > 0) throw new Error(errors.join("; "));
  const routeName = routeLabel(command.route);
  await ensureLabel(api, [routeName, "6e7781", `Active claims for ${command.route}`]);
  const active = await api("GET", `/issues?state=open&labels=${encodeURIComponent(`${LABELS.claimed[0]},${routeName}`)}&per_page=100`);
  if (active.length >= capsule.maxConcurrentClaimsPerRoute) errors.push(`route already has ${active.length} active claim(s); limit is ${capsule.maxConcurrentClaimsPerRoute}`);
  if (errors.length > 0) throw new Error(errors.join("; "));
  await transitionIssue(api, issue, {
    title: jobberTitle("CLAIMED", capsule, command.route),
    add: [LABELS.claimed[0], routeName],
    remove: [LABELS.ready[0]],
    addAssignee: login
  });
  await comment(api, issue.number, `[agent-build-claim/v2]\nstate: active\nroute: ${command.route}\nclaimant: @${login}\nproducer branch: \`${branch}\`\nintegration target: \`${markers.integration}\`\n\nCLAIM ACCEPTED. Pull the integration target, create the exact producer branch, and follow \`skills/agent-build-worker/SKILL.md\`.`);
  return { repository, issue: issue.number, action: "claimed", route: command.route };
}

async function verifyActiveClaim(api, issue, capsule, route, login) {
  const labels = labelsOf(issue);
  if (!labels.has(LABELS.claimed[0]) || !labels.has(routeLabel(route))) throw new Error("this route does not hold the active claim");
  if (!(capsule?.routeClaimants?.[route] ?? []).some((claimant) => claimant.toLowerCase() === login.toLowerCase())) throw new Error("GitHub identity is not authorized for the claimed route");
  if (!(issue.assignees ?? []).some((assignee) => assignee.login.toLowerCase() === login.toLowerCase())) throw new Error("commenter is not the active issue assignee");
}

async function release({ api, issue, capsule, command, login }) {
  await verifyActiveClaim(api, issue, capsule, command.route, login);
  const branch = producerBranch(capsule.capsuleId, command.route);
  const branchRef = await api("GET", `/git/ref/heads/${branch.split("/").map(encodeURIComponent).join("/")}`, undefined, true);
  if (branchRef !== null) throw new Error("producer branch exists; use /blocked and preserve the branch instead of releasing");
  await transitionIssue(api, issue, {
    title: jobberTitle("READY", capsule),
    add: [LABELS.ready[0]],
    remove: [LABELS.claimed[0], routeLabel(command.route)],
    removeAssignee: login
  });
  await comment(api, issue.number, `[agent-build-claim/v2]\nstate: released-unstarted\nroute: ${command.route}\nclaimant: @${login}\nreason: ${command.reason}\n\nReturned to the ready pool. No producer branch was found.`);
  return { issue: issue.number, action: "released", route: command.route };
}

async function blocked({ api, issue, capsule, command, login }) {
  await verifyActiveClaim(api, issue, capsule, command.route, login);
  await transitionIssue(api, issue, {
    title: jobberTitle("BLOCKED", capsule),
    add: [LABELS.help[0]],
    remove: [LABELS.claimed[0], routeLabel(command.route)],
    removeAssignee: login
  });
  await comment(api, issue.number, `[agent-build-claim/v2]\nstate: blocked-needs-triage\nroute: ${command.route}\nclaimant: @${login}\nreason: ${command.reason}\n\nDo not retry or transfer this capsule. Preserve any branch and evidence; Codex will amend, replace, or close it.`);
  return { issue: issue.number, action: "blocked", route: command.route };
}

async function submitted({ api, issue, capsule, markers, command, login, repository }) {
  await verifyActiveClaim(api, issue, capsule, command.route, login);
  const number = pullNumber(command.pullUrl, repository);
  if (!number) throw new Error("pull request URL must belong to this repository");
  const pull = await api("GET", `/pulls/${number}`);
  const expectedBranch = producerBranch(capsule.capsuleId, command.route);
  if (pull.state !== "open" || pull.head.ref !== expectedBranch || pull.base.ref !== markers.integration) {
    throw new Error("pull request is not open from the exact producer branch to the exact integration target");
  }
  await transitionIssue(api, issue, {
    title: jobberTitle("REVIEW", capsule),
    add: [LABELS.review[0]],
    remove: [LABELS.claimed[0], routeLabel(command.route)],
    removeAssignee: login
  });
  await comment(api, issue.number, `[agent-build-claim/v2]\nstate: submitted\nroute: ${command.route}\nclaimant: @${login}\npull request: ${command.pullUrl}\n\nSubmission recorded. Route capacity is released; the worker may claim another ready jobber without waiting for review.`);
  return { issue: issue.number, action: "submitted", route: command.route, pull: number };
}

export async function processJobberEvent({ event, api, repository }) {
  if (event.issue?.pull_request) return;
  const command = parseJobberCommand(event.comment?.body ?? "");
  if (!command) return;
  const issue = event.issue;
  const login = event.sender?.login ?? "";
  try {
    if (!TRUSTED_ASSOCIATIONS.has(event.comment?.author_association)) throw new Error("commenter is not a repository collaborator");
    const markers = issueMarkers(issue.body);
    if (!markers) throw new Error("issue lacks canonical Capsule and Integration markers");
    const capsule = await repositoryJson(api, markers.capsule, markers.integration);
    await Promise.all(Object.values(LABELS).map((label) => ensureLabel(api, label)));
    const context = { api, issue, capsule, markers, command, login, repository };
    const result = command.action === "claim" ? await claim(context)
      : command.action === "release" ? await release(context)
        : command.action === "blocked" ? await blocked(context)
          : await submitted(context);
    console.log(JSON.stringify(result));
    return result;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    await comment(api, issue.number, `JOBBER COMMAND REJECTED: ${detail}\n\nNo claim-state transition was accepted. Do not start or retry work from this command.`);
    throw error;
  }
}

async function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  const token = process.env.GITHUB_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!token || !repository) throw new Error("GitHub workflow context is incomplete");
  return processJobberEvent({ event, api: createApi(repository, token), repository });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
