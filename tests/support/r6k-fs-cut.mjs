import { writeSync } from "node:fs";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename } from "node:path";
const root = process.env.R6K_CUT_ROOT, boundary = process.env.R6K_CUT_BOUNDARY;
const phase = process.env.R6K_CUT_PHASE ?? "after";
const hit = Number(process.env.R6K_CUT_HIT ?? 1);
let hits = 0;
function type(path) {
  path = String(path);
  if (!root || !path.startsWith(root + "/")) return "other";
  const name = basename(path);
  if (name.endsWith(".guard")) return "guard";
  if (name.endsWith(".tmp.dir")) return "candidate";
  if (name.includes(".reap-") && name.endsWith(".tmp")) return "marker-scratch";
  if (name.includes(".reap-")) return "marker";
  if (name.endsWith(".tmp")) return "contender";
  if (name.startsWith("owner-")) return "owner";
  if (name.endsWith(".lock")) return "canonical";
  return "other";
}
function cut(at, when) {
  if (boundary === at && phase === when && ++hits === hit) {
    writeSync(1, JSON.stringify({ cut: at, phase, hit: hits }) + "\n");
    process.kill(process.pid, "SIGKILL");
  }
}
for (const verb of ["mkdir", "link", "unlink", "rename", "rmdir"]) {
  const original = fs[verb];
  fs[verb] = async (...args) => {
    const at = `${verb}:${type(["rename", "link"].includes(verb) ? args[1] : args[0])}`;
    cut(at, "before"); const value = await original(...args); cut(at, "after"); return value;
  };
}
const originalOpen = fs.open;
fs.open = async (...args) => {
  const kind = type(args[0]); cut(`open:${kind}`, "before");
  if (process.env.R6K_IGNORE_KERNEL === "1" && type(args[0]) === "guard" && typeof args[1] === "number") args[1] &= ~0x20;
  const handle = await originalOpen(...args); cut(`open:${kind}`, "after");
  for (const method of ["writeFile", "sync", "close"]) {
    const original = handle[method].bind(handle);
    handle[method] = async (...params) => {
      const at = `${method}:${kind}`; cut(at, "before");
      const value = await original(...params); cut(at, "after"); return value;
    };
  }
  return handle;
};
syncBuiltinESMExports();
