// Tests for the shared repository-guard helpers. Every script that takes a
// `repository` argument must reject paths outside the repo, and every
// relative-path computation must normalize Windows backslashes first.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { assertInsideRepository, normalizeRelative, resolveRepository } from '../scripts/runtime-license-repository-guard.mjs';

test('assertInsideRepository accepts paths inside the repository', () => {
  const repo = fs.realpathSync(os.tmpdir());  // use a real dir
  assert.doesNotThrow(() => assertInsideRepository(repo, repo));
  assert.doesNotThrow(() => assertInsideRepository(repo, path.join(repo, 'subdir', 'file.txt')));
});

test('assertInsideRepository rejects paths outside the repository', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  try {
    assert.throws(() => assertInsideRepository(repo, '/etc/passwd'), /license_path_outside_repository/);
    assert.throws(() => assertInsideRepository(repo, path.join(repo, '..', 'outside')), /license_path_outside_repository/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('assertInsideRepository rejects a symlink that escapes the repository', () => {
  // Reviewer finding: previously, realpathSync(parent) + basename was
  // sufficient to bypass the guard when the basename itself was a symlink
  // to an outside target. The guard now resolves the full candidate path
  // when it exists.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-sym-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-outside-'));
  try {
    fs.writeFileSync(path.join(outside, 'passwd'), 'outside content\n');
    try { fs.symlinkSync(path.join(outside, 'passwd'), path.join(repo, 'escape')); }
    catch { /* sandboxed macOS may refuse — skip */ return; }
    assert.throws(() => assertInsideRepository(repo, path.join(repo, 'escape')), /license_path_outside_repository/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('assertInsideRepository rejects a dangling symlink whose target would be outside the repository', () => {
  // Reviewer finding (3rd round): a dangling symlink whose target is a
  // non-existent path outside the repository must still be rejected.
  // `realpathSync` throws ENOENT for the full path; the guard must fall
  // through to readlink-based target resolution rather than accepting
  // the symlink as if it were an in-repo file.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-dangling-'));
  try {
    try {
      fs.symlinkSync('/definitely/nonexistent/outside/the/repo', path.join(repo, 'dangling'));
    } catch { /* sandboxed macOS may refuse */ return; }
    assert.throws(() => assertInsideRepository(repo, path.join(repo, 'dangling')), /license_path_outside_repository/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('assertInsideRepository accepts a dangling symlink whose target resolves inside the repository', () => {
  // Symmetric positive case: a dangling symlink whose target is INSIDE
  // the repository must still be accepted (the guard only rejects
  // escapes, not dangling-but-in-repo links).
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-dangling-in-'));
  try {
    const insideTarget = path.join(repo, 'will-be-created', 'file.txt');
    try {
      fs.symlinkSync(insideTarget, path.join(repo, 'sym'));
    } catch { /* sandboxed macOS may refuse */ return; }
    assert.doesNotThrow(() => assertInsideRepository(repo, path.join(repo, 'sym')));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('assertInsideRepository throws when repository does not exist', () => {
  const fake = path.join(os.tmpdir(), 'definitely-not-a-real-repo-' + Date.now());
  assert.throws(() => assertInsideRepository(fake), /license_repository_not_found/);
});

test('normalizeRelative rejects absolute paths outside the repo', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  try {
    assert.throws(() => normalizeRelative(repo, '/etc/passwd'), /license_path_outside_repository/);
    assert.throws(() => normalizeRelative(repo, path.join(repo, '..', '..', 'etc')), /license_path_outside_repository/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('normalizeRelative produces forward-slash paths', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  try {
    const abs = path.join(repo, 'sub', 'file.txt');
    const rel = normalizeRelative(repo, abs);
    assert.ok(!rel.includes('\\'), `relative path still contains backslash: ${rel}`);
    assert.equal(rel, 'sub/file.txt');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('normalizeRelative normalizes Windows backslashes', () => {
  // On POSIX, Node's `path.relative` does not understand `\` as a separator.
  // The function MUST convert backslashes to forward slashes first, otherwise
  // a Windows captured input would either compute an absolute path or be
  // rejected as outside the repo.
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  try {
    const winStyle = repo + '\\node_modules\\.pnpm\\win@1.0.0\\node_modules\\win';
    const rel = normalizeRelative(repo, winStyle);
    assert.ok(!rel.includes('\\'), `relative path still contains backslash: ${rel}`);
    assert.equal(rel, 'node_modules/.pnpm/win@1.0.0/node_modules/win');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('normalizeRelative normalizes mixed separators', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-'));
  try {
    const mixed = repo + '/mixed\\separators/file.txt';
    const rel = normalizeRelative(repo, mixed);
    assert.equal(rel, 'mixed/separators/file.txt');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('resolveRepository returns the realpath', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-real-'));
  try {
    const resolved = resolveRepository(repo);
    assert.equal(resolved, fs.realpathSync(repo));
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('resolveRepository throws on a path that does not exist', () => {
  const fake = path.join(os.tmpdir(), 'no-such-dir-' + Date.now());
  assert.throws(() => resolveRepository(fake), /license_repository_not_found/);
});
