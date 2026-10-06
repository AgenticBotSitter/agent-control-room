#!/bin/sh
# Control Room one-command install (Apple silicon Mac). Run in Terminal:
#   /bin/sh -c "$(curl -fsSL https://raw.githubusercontent.com/AgenticBotSitter/agent-control-room/<commit>/scripts/install.sh)" install <commit>
# <commit> is the 40-character release commit from the release page. Naming it in this command
# is the install confirmation. You are asked for your Mac password, then the GitHub read token,
# and at the end you scan a QR code with your phone to set up sign-in.
set -eu
stop() { printf 'Control Room install stopped: %s\n' "$1" >&2; exit 1; }

commit=${1:-}
case "$commit" in *[!0-9a-f]*|'') stop 'give the 40-character release commit after "install"' ;; esac
[ "${#commit}" -eq 40 ] || stop 'give the 40-character release commit after "install"'
[ "$(/usr/bin/uname -s)" = Darwin ] && [ "$(/usr/bin/uname -m)" = arm64 ] || stop 'this installer is for Apple silicon Macs'
[ "$(/usr/bin/id -u)" != 0 ] || stop 'run it as yourself, not with sudo; it asks for your password itself'
[ -t 0 ] || stop 'run it in a Terminal window (the phone code at the end is typed there)'

/usr/bin/xcode-select -p >/dev/null 2>&1 && /usr/bin/xcrun --find git >/dev/null 2>&1 \
  || stop "Apple's Command Line Tools are needed first: run  xcode-select --install  then run this line again"

printf '%s\n' "Installing Control Room release $commit." \
  'Next: your Mac password, then the GitHub read token (nothing shows while you type or paste).'
# Everything privileged happens inside one fixed root command: it makes the private root-owned
# folder, downloads the bootstrap pinned to this commit straight into it, and runs it from there,
# so no file your login can write is ever run as root. The bootstrap then proves its own bytes
# equal this commit's copy before it installs anything.
exec /usr/bin/sudo /bin/sh -c 'set -eu
commit=$1
root=$(/usr/bin/mktemp -d /var/root/cr-boot.XXXXXX)
/usr/bin/curl -fsSL --proto "=https" --tlsv1.2 --max-time 120 -o "$root/bootstrap.sh" \
  "https://raw.githubusercontent.com/AgenticBotSitter/agent-control-room/$commit/scripts/install-night/bootstrap.sh" || {
  /bin/rm -rf "$root"; printf "%s\n" "Control Room install stopped: could not download the installer for that commit" >&2; exit 1; }
exec /bin/sh "$root/bootstrap.sh" "$commit" "$root" --confirmed-by-command yes' control-room-install "$commit"
