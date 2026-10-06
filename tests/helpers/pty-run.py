# Run a command with a PSEUDO-TERMINAL as its controlling terminal, the way the
# installer runs on install night (`sudo` in Terminal), and press Enter on that
# terminal once a second. Used by the M1 lane's Blocker-2 test: a PG tool that
# tried to prompt would either print its prompt into this transcript or consume
# the Enter presses, and both are asserted against.
#
# `script(1)` cannot be used: on macOS it refuses ("tcgetattr/ioctl: Operation
# not supported on socket") when its own stdin is not a terminal, which is the
# case under the test runner. `pty.fork` needs no terminal of its own.
#
# The transcript goes to stdout; the exit status is the child's.
import os
import pty
import select
import sys
import time

pid, master = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])

out = sys.stdout.buffer
last_enter = 0.0
status = None
while True:
    if time.monotonic() - last_enter > 1.0:
        try:
            os.write(master, b"\n")
        except OSError:
            pass
        last_enter = time.monotonic()
    ready, _, _ = select.select([master], [], [], 0.2)
    if master in ready:
        try:
            data = os.read(master, 65536)
        except OSError:
            data = b""
        if data:
            out.write(data)
            out.flush()
            continue
    if status is None:
        done, raw = os.waitpid(pid, os.WNOHANG)
        if done:
            status = raw
            deadline = time.monotonic() + 1.0
    if status is not None and time.monotonic() > deadline:
        break
sys.exit(os.waitstatus_to_exitcode(status))
