import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findClientBundleNodeGlobals, main } from "../scripts/check-client-bundle-node-globals.mjs";

test("the check catches every requested Node-only browser dependency", () => {
  const root = mkdtempSync(join(tmpdir(), "client-bundle-node-globals-"));
  try {
    const probes = [
      ["Buffer", 'Buffer.byteLength(e,"utf8")'],
      ["Buffer", 'globalThis.saved=Buffer'],
      ["process", 'process.env.FOO'],
      ["process", 'process.customMember'],
      ["process", 'process . customMember'],
      ["require", 'require("legacy-module")'],
      ["require", 'require ("legacy-module")'],
      ["node: specifier", 'import{x}from"node:crypto"'],
      ["node: specifier", 'import "node:fs"'],
      ["node: specifier", 'import("node:fs/promises")'],
      ["node: specifier", 'import(`node:fs/promises`)'],
      ["node: specifier", 'export{x}from"node:path"'],
      ["node: specifier", 'require("node:fs")'],
    ];
    mkdirSync(join(root, "nested"));
    for (const [index, [name, source]] of probes.entries()) {
      const file = join(root, "nested", `${index}.js`);
      writeFileSync(file, source);
      assert.ok(findClientBundleNodeGlobals(root).some(match => match.file === file && match.name === name), source);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the check does not flag identifiers that merely contain the bare words", () => {
  const root = mkdtempSync(join(tmpdir(), "client-bundle-node-globals-safe-"));
  try {
    writeFileSync(join(root, "safe.js"), "const myBufferThing={byteLength:3};myBufferThing.byteLength;"
      + "const myprocess={env:1};myprocess.env;const nodeModule={fs:1};nodeModule.fs;const id='node:inventory:001';");
    assert.deepEqual(findClientBundleNodeGlobals(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the real built client bundle (R4U-01) is free of Node-only globals", () => {
  const matches = findClientBundleNodeGlobals("dist-vps/client");
  assert.deepEqual(matches, []);
});

test("the check refuses a missing build instead of reporting success", () => {
  const root = mkdtempSync(join(tmpdir(), "client-bundle-missing-"));
  try {
    assert.throws(() => findClientBundleNodeGlobals(join(root, "missing")), { code: "ENOENT" });
    assert.throws(() => findClientBundleNodeGlobals(root), /client_bundle_missing_javascript/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the command reports every unsafe chunk and returns a failing exit code", () => {
  const root = mkdtempSync(join(tmpdir(), "client-bundle-command-"));
  const previousExitCode = process.exitCode;
  const previousError = console.error;
  const errors = [];
  console.error = message => errors.push(message);
  try {
    writeFileSync(join(root, "safe.js"), "globalThis.browserSafe=true");
    process.exitCode = undefined;
    main(root);
    assert.equal(process.exitCode, undefined);
    writeFileSync(join(root, "unsafe.js"), 'Buffer.from("x");require("legacy");process.customMember;import "node:fs"');
    main(root);
    assert.equal(process.exitCode, 1);
    assert.equal(errors.length, 4);
    for (const name of ["Buffer", "require", "process", "node: specifier"])
      assert.ok(errors.some(message => message.includes(`Node-only global ${name}`)), name);
  } finally {
    process.exitCode = previousExitCode;
    console.error = previousError;
    rmSync(root, { recursive: true, force: true });
  }
});

// Kept from int7's copy of R4U-01: one finding per unsafe chunk, across nested folders.
test("the check catches Buffer, process.* and node: specifiers surviving minification", () => {
  const root = mkdtempSync(join(tmpdir(), "client-bundle-node-globals-"));
  try {
    writeFileSync(join(root, "a.js"), 'if(Buffer.byteLength(e,"utf8")>n)throw Error("x")');
    writeFileSync(join(root, "b.js"), "console.log(process.env.FOO)");
    mkdirSync(join(root, "nested"));
    writeFileSync(join(root, "nested", "c.js"), 'import{x}from"node:crypto"');
    const matches = findClientBundleNodeGlobals(root);
    const found = new Set(matches.map(match => match.name));
    assert.equal(found.has("Buffer"), true);
    assert.equal(found.has("process"), true);
    assert.equal(found.has("node: specifier"), true);
    assert.equal(matches.length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
