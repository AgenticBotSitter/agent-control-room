# VPS front-door survey

After install night, open the VPS provider's **web console**. Do not run this
from the Mac. Paste the reviewed script there as root, or prefix its invocation
with `sudo sh` if the console gives you an ordinary account.

The script only reads local service, listener, firewall, disk and memory
information. It does not make a network connection, install anything, or change
the VPS. It does not print configuration files, credentials, or keys.

When it finishes, copy **only** the lines from `BEGIN_VPS_SURVEY` through
`END_VPS_SURVEY` and send that block to the lead. Do not send screenshots of
the console or other command output. The lead uses the block to choose the
matching FD-7 setup variant and to decide whether the existing website can move
to loopback safely or needs a second public IPv4 address.

If the block says the website server is unclear, or says the firewall requires
manual review, stop there and send the block. Do not try setup commands.
