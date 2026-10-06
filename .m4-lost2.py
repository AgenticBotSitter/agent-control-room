#!/usr/bin/env python3
"""Per-file lines-lost report for an in-progress (conflicted) merge.

For every file either side changed since the merge base, take the lines the
OTHER side added relative to the merge base, and report which of them are not
present in the working-tree result. For a conflicted file that lists exactly
what the resolution still owes each side.

  .m4-lost2.py <base> <ours> <theirs> <worktree>
"""
import subprocess, sys, os, collections

base, ours, theirs, result = sys.argv[1:5]


def git(*a):
    return subprocess.run(("git",) + a, capture_output=True, text=True, check=True).stdout


def read(spec):
    r = subprocess.run(("git", "show", spec), capture_output=True, text=True)
    return r.stdout.splitlines() if r.returncode == 0 else None


def result_lines(path):
    p = os.path.join(result, path)
    if not os.path.exists(p):
        return None
    with open(p, encoding="utf-8", errors="replace") as f:
        return f.read().splitlines()


def conflicted(path):
    r = subprocess.run(["git", "diff", "--name-only", "--diff-filter=U"],
                       capture_output=True, text=True)
    return path in r.stdout.splitlines()


files = sorted(set(l for l in git("diff", "--name-only", base, ours).splitlines() if l.strip())
               | set(l for l in git("diff", "--name-only", base, theirs).splitlines() if l.strip()))
total = 0
for path in files:
    bl = read(f"{base}:{path}") or []
    added = {name: collections.Counter() for name in ("ours", "theirs")}
    for name, side in (("ours", ours), ("theirs", theirs)):
        sl = read(f"{side}:{path}")
        if sl is None:
            continue
        d = collections.Counter(bl)
        for line in sl:
            if d[line] > 0:
                d[line] -= 1
            else:
                added[name][line] += 1
    rl = result_lines(path)
    if rl is None:
        if any(added.values()):
            print(f"!! DELETED FILE {path}")
        continue
    rc = collections.Counter(rl)
    lost = 0
    rows = []
    for name in ("ours", "theirs"):
        for line, n in added[name].items():
            if rc[line] < n:
                lost += n - rc[line]
                rows.append(f"  [{name}] {line.strip()[:160]}")
    if lost:
        total += lost
        mark = "CONFLICT" if conflicted(path) else "unmerged?"
        print(f"{path} — {lost} line(s) {mark}")
        print("\n".join(rows))
print(f"--- total lines still lost: {total}")
