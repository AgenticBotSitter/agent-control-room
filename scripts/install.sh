#!/bin/sh
# Control Room one-command install (Apple silicon Mac). Run in Terminal:
#   /bin/sh -c "$(curl -fsSL https://raw.githubusercontent.com/AgenticBotSitter/agent-control-room/<commit>/scripts/install.sh)" install <commit>
# <commit> is the 40-character release commit from the release page. Naming it in this command
# is the install confirmation. You are asked for your Mac password, then the GitHub read token,
# and at the end you scan a QR code with your phone to set up sign-in.
set -eu
REPOSITORY=AgenticBotSitter/agent-control-room
stop() { printf 'Control Room install stopped: %s\n' "$1" >&2; exit 1; }

commit=${1:-}
case "$commit" in *[!0-9a-f]*|'') stop 'give the 40-character release commit after "install"' ;; esac
[ "${#commit}" -eq 40 ] || stop 'give the 40-character release commit after "install"'
[ "$(/usr/bin/uname -s)" = Darwin ] && [ "$(/usr/bin/uname -m)" = arm64 ] || stop 'this installer is for Apple silicon Macs'
[ "$(/usr/bin/id -u)" != 0 ] || stop 'run it as yourself, not with sudo; it asks for your password itself'
[ -t 0 ] || stop 'run it in a Terminal window (the phone code at the end is typed there)'

work=$(/usr/bin/mktemp -d /private/tmp/control-room-install.XXXXXX) || stop 'could not make a temporary folder'
trap '/bin/rm -rf "$work"' 0 1 2 3 15
/usr/bin/curl -fsSL --proto '=https' --tlsv1.2 --max-time 120 -o "$work/bootstrap.sh" \
  "https://raw.githubusercontent.com/$REPOSITORY/$commit/scripts/install-night/bootstrap.sh" \
  || stop 'could not download the installer for that commit'

printf '%s\n' "Installing Control Room release $commit." \
  'Next: your Mac password, then the GitHub read token (nothing shows while you type or paste).'
root=$(/usr/bin/sudo /usr/bin/mktemp -d /var/root/cr-boot.XXXXXX) || stop 'the Mac password was not accepted'
# The bootstrap proves its own bytes equal this commit's copy before it installs anything.
/usr/bin/sudo /bin/sh "$work/bootstrap.sh" "$commit" "$root" --confirmed-by-command yes
