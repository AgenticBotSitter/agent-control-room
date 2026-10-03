#!/bin/sh
set -eu
umask 077

# These literals are checked against runtime-inventory.json. This script is
# fetched from raw.githubusercontent.com at the one phone-confirmed commit; it
# later proves that its bytes equal the copy in that commit's git archive.
NODE_VERSION='22.23.3'
NODE_ARCHIVE_NAME='node-v22.23.3-darwin-arm64.tar.gz'
NODE_ARCHIVE_URL='https://nodejs.org/dist/v22.23.3/node-v22.23.3-darwin-arm64.tar.gz'
NODE_ARCHIVE_SHA256='23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53'
NODE_ARCHIVE_BYTES='49963763'
REMOTE_URL='https://github.com/AgenticBotSitter/agent-control-room.git'

refuse() {
  case "$1" in
    bootstrap_token_refused) recovery='The read token was empty or not accepted. The installer has not started.' ;;
    bootstrap_commit_refused|bootstrap_arguments_refused|bootstrap_rehearsal_arguments_refused) recovery='The install line was not accepted. The installer has not started.' ;;
    *) recovery='Preparation stopped. The installer has not started.' ;;
  esac
  printf '%s\n' "$recovery Do not retry. Keep the Terminal message and show the lead after reopening Claude." "$1" >&2
  exit 1
}
refuse_dotdot() { case "$1" in ..|../*|*/../*|*/..) refuse "$2" ;; esac; }

[ "$#" -ge 2 ] || refuse 'bootstrap_arguments_refused'
commit=$1
d=$2
shift 2
rehearsal_config=
fresh_database=
authenticator=
e2e2_evidence_log=
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || refuse 'bootstrap_arguments_refused'
  case "$1" in
    --rehearsal-config) [ -z "$rehearsal_config" ] || refuse 'bootstrap_arguments_refused'; rehearsal_config=$2 ;;
    --fresh-database) [ -z "$fresh_database" ] || refuse 'bootstrap_arguments_refused'; fresh_database=$2 ;;
    --authenticator) [ -z "$authenticator" ] || refuse 'bootstrap_arguments_refused'; authenticator=$2 ;;
    --e2e2-evidence-log) [ -z "$e2e2_evidence_log" ] || refuse 'bootstrap_arguments_refused'; e2e2_evidence_log=$2 ;;
    *) refuse 'bootstrap_arguments_refused' ;;
  esac
  shift 2
done
[ -z "$rehearsal_config" ] || { case "$rehearsal_config" in /*) ;; *) refuse 'bootstrap_rehearsal_config_refused' ;; esac; refuse_dotdot "$rehearsal_config" 'bootstrap_rehearsal_config_refused'; }
[ -z "$fresh_database" ] || [ "$fresh_database" = yes ] || refuse 'bootstrap_fresh_database_refused'
[ -z "$authenticator" ] || [ "$authenticator" = software ] || refuse 'bootstrap_authenticator_refused'
[ -z "$e2e2_evidence_log" ] || { case "$e2e2_evidence_log" in /*/e2e2-evidence.jsonl) ;; *) refuse 'bootstrap_evidence_log_refused' ;; esac; refuse_dotdot "$e2e2_evidence_log" 'bootstrap_evidence_log_refused'; }
if [ -n "$rehearsal_config" ]; then
  [ "$fresh_database" = yes ] && [ "$authenticator" = software ] && [ -n "$e2e2_evidence_log" ] \
    || refuse 'bootstrap_rehearsal_arguments_refused'
else
  [ -z "$authenticator" ] && [ -z "$e2e2_evidence_log" ] || refuse 'bootstrap_rehearsal_arguments_refused'
fi
refuse_dotdot "$d" 'bootstrap_root_refused'
case "$commit" in *[!0-9a-f]*|'') refuse 'bootstrap_commit_refused' ;; esac
[ "${#commit}" -eq 40 ] || refuse 'bootstrap_commit_refused'

testing=0
# /private/tmp is macOS's real temp directory (/tmp is a symlink to it); plain
# /tmp is Linux's. Both are accepted so the rehearsal/test harness this block
# gates can run on either host -- every other OS-identifying check in this
# script (UNAME, below) is satisfied by an injected fake, but a filesystem
# prefix check against the REAL path cannot be faked the same way, and a CI
# lane on Linux has no /private/tmp at all.
test_tmpdir=
if [ "${CONTROL_ROOM_BOOTSTRAP_TESTING-}" = 1 ]; then
  case "$d" in
    /private/tmp/*) testing=1; test_tmpdir=/private/tmp ;;
    /tmp/*) testing=1; test_tmpdir=/tmp ;;
    *) refuse 'bootstrap_test_root_refused' ;;
  esac
  refuse_dotdot "${CONTROL_ROOM_BOOTSTRAP_TOOL_DIR-}" 'bootstrap_test_tools_refused'
  case "${CONTROL_ROOM_BOOTSTRAP_TOOL_DIR-}" in /private/tmp/*|/tmp/*) ;; *) refuse 'bootstrap_test_tools_refused' ;; esac
fi

if [ "$testing" -eq 1 ]; then
  tool_dir=$CONTROL_ROOM_BOOTSTRAP_TOOL_DIR
  ID=$tool_dir/id UNAME=$tool_dir/uname STAT=$tool_dir/stat SUDO=$tool_dir/sudo STTY=$tool_dir/stty
  CURL=$tool_dir/curl SHASUM=$tool_dir/shasum TAR=$tool_dir/tar CHFLAGS=$tool_dir/chflags
  CHMOD=$tool_dir/chmod CHOWN=$tool_dir/chown XCRUN=$tool_dir/xcrun GIT=$tool_dir/git
  RM=$tool_dir/rm MKDIR=$tool_dir/mkdir CMP=$tool_dir/cmp ENV=$tool_dir/env CAT=$tool_dir/cat FIND=$tool_dir/find
  TTY_PATH=${CONTROL_ROOM_BOOTSTRAP_TTY-}
  refuse_dotdot "$TTY_PATH" 'bootstrap_test_tty_refused'
  case "$TTY_PATH" in /private/tmp/*|/tmp/*) ;; '') TTY_PATH=/dev/null ;; *) refuse 'bootstrap_test_tty_refused' ;; esac
  TOKEN_INPUT=${CONTROL_ROOM_BOOTSTRAP_TOKEN_INPUT-$TTY_PATH}
  refuse_dotdot "$TOKEN_INPUT" 'bootstrap_test_tty_refused'
  case "$TOKEN_INPUT" in /private/tmp/*|/tmp/*) ;; /dev/null) ;; *) refuse 'bootstrap_test_tty_refused' ;; esac
else
  ID=/usr/bin/id UNAME=/usr/bin/uname STAT=/usr/bin/stat SUDO=/usr/bin/sudo STTY=/bin/stty
  CURL=/usr/bin/curl SHASUM=/usr/bin/shasum TAR=/usr/bin/tar CHFLAGS=/usr/bin/chflags
  CHMOD=/bin/chmod CHOWN=/usr/sbin/chown XCRUN=/usr/bin/xcrun GIT=
  RM=/bin/rm MKDIR=/bin/mkdir CMP=/usr/bin/cmp ENV=/usr/bin/env CAT=/bin/cat FIND=/usr/bin/find
  TTY_PATH=/dev/tty TOKEN_INPUT=/dev/tty
fi

# Armed only once "$d" is proved to be the private root-owned 0700 folder below:
# an earlier refusal must never delete whatever path it was given (atk-fa F1).
cleanup=0
cleanup_bootstrap() { if [ "$cleanup" -eq 1 ]; then "$RM" -rf -- "$d" >/dev/null 2>&1 || :; fi; }
restore_tty() { "$STTY" echo < "$TTY_PATH" >/dev/null 2>&1 || :; }
trap 'restore_tty; cleanup_bootstrap' 0 1 2 3 15

[ "$("$ID" -u)" = 0 ] || refuse 'bootstrap_root_required'
case "${SUDO_UID-}" in *[!0-9]*|'') refuse 'bootstrap_invoking_user_refused' ;; esac
case "${SUDO_GID-}" in *[!0-9]*|'') refuse 'bootstrap_invoking_user_refused' ;; esac
case "${SUDO_USER-}" in *[!A-Za-z0-9._-]*|'') refuse 'bootstrap_invoking_user_refused' ;; esac
[ "$SUDO_UID" -ge 501 ] || refuse 'bootstrap_invoking_user_refused'
[ "$SUDO_GID" -ge 1 ] || refuse 'bootstrap_invoking_user_refused'
[ "$("$UNAME" -s)" = Darwin ] || refuse 'bootstrap_platform_refused'
[ "$("$UNAME" -m)" = arm64 ] || refuse 'bootstrap_platform_refused'
if [ "$testing" -eq 0 ]; then case "$d" in /var/root/cr-boot.*) ;; *) refuse 'bootstrap_root_refused' ;; esac; fi
[ ! -L "$d" ] && [ -d "$d" ] || refuse 'bootstrap_root_refused'
set -- $("$STAT" -f '%u %Lp %HT' "$d")
[ "$1" = 0 ] && [ "$2" = 700 ] && [ "$3" = Directory ] || refuse 'bootstrap_root_refused'
cleanup=1

# Drop the owner's cached sudo authority before any network work starts.
"$SUDO" -n -u "#$SUDO_UID" /usr/bin/sudo -K || refuse 'bootstrap_sudo_timestamp_refused'

token_file=$d/github-read.token
if [ ! -e "$token_file" ]; then
  "$STTY" -echo < "$TTY_PATH" || refuse 'bootstrap_terminal_refused'
  printf 'GitHub read token: ' > "$TTY_PATH"
  IFS= read -r token < "$TOKEN_INPUT" || { restore_tty; refuse 'bootstrap_token_refused'; }
  restore_tty
  printf '\n' > "$TTY_PATH"
  case "$token" in *[!A-Za-z0-9._~-]*|'') refuse 'bootstrap_token_refused' ;; esac
  [ "${#token}" -le 1024 ] || refuse 'bootstrap_token_refused'
  (umask 077; printf '%s\n' "$token" > "$token_file")
else
  [ ! -L "$token_file" ] && [ -f "$token_file" ] || refuse 'bootstrap_token_refused'
  IFS= read -r token < "$token_file" || refuse 'bootstrap_token_refused'
  case "$token" in *[!A-Za-z0-9._~-]*|'') refuse 'bootstrap_token_refused' ;; esac
  [ "${#token}" -le 1024 ] || refuse 'bootstrap_token_refused'
fi
"$CHMOD" 600 "$token_file"

node_archive=$d/node.tar.gz
node_root=$d/node
"$CURL" -q --proto '=https' --tlsv1.2 --fail --silent --show-error --location \
  --max-time 1800 --max-filesize "$NODE_ARCHIVE_BYTES" --output "$node_archive" "$NODE_ARCHIVE_URL" \
  || refuse 'bootstrap_node_download_refused'
[ "$("$STAT" -f '%z' "$node_archive")" = "$NODE_ARCHIVE_BYTES" ] || refuse 'bootstrap_node_size_refused'
printf '%s  %s\n' "$NODE_ARCHIVE_SHA256" "$node_archive" | "$SHASUM" -a 256 -c -s \
  || refuse 'bootstrap_node_digest_refused'
"$MKDIR" -m 700 "$node_root"
"$TAR" -xzf "$node_archive" --no-same-owner --no-same-permissions --strip-components 1 -C "$node_root" \
  || refuse 'bootstrap_node_archive_refused'
"$CHFLAGS" -R 0 "$node_root" || refuse 'bootstrap_node_metadata_refused'
"$CHMOD" -RN "$node_root" || refuse 'bootstrap_node_metadata_refused'
"$CHOWN" -R -h 0:0 "$node_root" || refuse 'bootstrap_node_metadata_refused'
"$CHMOD" -R go-w "$node_root" || refuse 'bootstrap_node_metadata_refused'

if [ "$testing" -eq 0 ]; then
  GIT=$("$XCRUN" --find git) || refuse 'bootstrap_git_refused'
  case "$GIT" in /*) ;; *) refuse 'bootstrap_git_refused' ;; esac
  [ ! -L "$GIT" ] && [ -x "$GIT" ] || refuse 'bootstrap_git_refused'
  check=$GIT
  while :; do
    set -- $("$STAT" -f '%u %Lp %HT' "$check")
    [ "$1" = 0 ] || refuse 'bootstrap_git_refused'
    permissions=$((0$2))
    [ $((permissions & 18)) -eq 0 ] || refuse 'bootstrap_git_refused'
    [ ! -L "$check" ] || refuse 'bootstrap_git_refused'
    [ "$check" = / ] && break
    check=${check%/*}; [ -n "$check" ] || check=/
  done
else
  resolved_git=$("$XCRUN" --find git) || refuse 'bootstrap_git_refused'
  [ "$resolved_git" = "$GIT" ] || refuse 'bootstrap_git_refused'
fi

mirror=$d/mirror.git
[ ! -e "$mirror" ] || refuse 'bootstrap_mirror_exists'
git_env() {
  "$ENV" -i LANG=C LC_ALL=C HOME=/var/empty XDG_CONFIG_HOME=/var/empty \
    GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null \
    GIT_ATTR_NOSYSTEM=1 GIT_NO_REPLACE_OBJECTS=1 CONTROL_ROOM_GITHUB_TOKEN_FILE="$token_file" \
    "$GIT" "$@"
}
git_run() { git_env --git-dir "$mirror" -c core.hooksPath=/dev/null -c core.attributesFile=/dev/null "$@"; }
git_env -c core.hooksPath=/dev/null -c core.attributesFile=/dev/null init --bare "$mirror" \
  || refuse 'bootstrap_mirror_init_refused'
"$RM" -rf -- "$mirror/hooks"

cred=$d/cred.sh
"$CAT" > "$cred" <<'CREDENTIAL_HELPER'
#!/bin/sh
set -eu
case "${1-}" in
  get)
    protocol= host=
    while IFS='=' read -r key value; do
      case "$key" in protocol) protocol=$value ;; host) host=$value ;; '') break ;; esac
    done
    [ "$protocol" = https ] && [ "$host" = github.com ] || exit 0
    IFS= read -r token < "$CONTROL_ROOM_GITHUB_TOKEN_FILE"
    printf 'username=x-access-token\npassword=%s\n' "$token"
    ;;
esac
CREDENTIAL_HELPER
"$CHMOD" 500 "$cred"

git_run -c credential.helper="$cred" -c protocol.allow=never -c protocol.https.allow=always \
  -c transfer.fsckObjects=true -c http.followRedirects=false fetch --force --no-tags --no-write-fetch-head "$REMOTE_URL" \
  '+refs/heads/main:refs/heads/control-room-attended-main' "+$commit:refs/install-night/confirmed" \
  || refuse 'bootstrap_fetch_refused'
"$RM" -rf -- "$mirror/hooks"
"$RM" -f -- "$mirror/info/attributes"

config_list=$d/git-config.names
git_run config --local --name-only --get-regexp '.*' > "$config_list" 2>/dev/null \
  || refuse 'bootstrap_git_config_refused'
while IFS= read -r key; do
  case "$key" in core.repositoryformatversion|core.filemode|core.bare|core.ignorecase|core.precomposeunicode) ;;
    '') ;; *) refuse 'bootstrap_git_config_refused' ;;
  esac
done < "$config_list"

resolved=$(git_run rev-parse 'refs/install-night/confirmed^{commit}') || refuse 'bootstrap_commit_refused'
[ "$resolved" = "$commit" ] || refuse 'bootstrap_commit_refused'
git_run merge-base --is-ancestor "$commit" refs/heads/control-room-attended-main \
  || refuse 'bootstrap_commit_not_on_main'

set +e
git_run grep -I -n -E '(^|[[:space:]])(export-ignore|export-subst|ident([=[:space:]]|$)|working-tree-encoding([=[:space:]]|$)|filter([=[:space:]]|$))' \
  "$commit" -- .gitattributes '*/.gitattributes' >/dev/null 2>&1
attribute_status=$?
set -e
[ "$attribute_status" -eq 1 ] || { [ "$attribute_status" -eq 0 ] && refuse 'bootstrap_attributes_refused'; refuse 'bootstrap_git_refused'; }

source_tar=$d/source.tar
source_root=$d/source
"$MKDIR" -m 700 "$source_root"
git_run archive --format=tar --output="$source_tar" "$commit" || refuse 'bootstrap_archive_refused'
"$TAR" -xf "$source_tar" --no-same-owner --no-same-permissions -C "$source_root" \
  || refuse 'bootstrap_archive_refused'
[ -z "$("$FIND" "$source_root" -type l -print -quit)" ] || refuse 'bootstrap_source_link_refused'
"$CHFLAGS" -R 0 "$source_root" || refuse 'bootstrap_source_metadata_refused'
"$CHMOD" -RN "$source_root" || refuse 'bootstrap_source_metadata_refused'
"$CHOWN" -R -h 0:0 "$source_root" || refuse 'bootstrap_source_metadata_refused'
"$CHMOD" -R go-w "$source_root" || refuse 'bootstrap_source_metadata_refused'

# The raw-file fetch and archive must agree byte for byte. commit40 is the only
# human trust anchor; a second unverified digest is deliberately not accepted.
"$CMP" -s -- "$0" "$source_root/scripts/install-night/bootstrap.sh" \
  || refuse 'bootstrap_script_consistency_refused'

"$node_root/bin/node" --input-type=module --eval \
  'const [commit,remoteUrl,git,version,archive,sha256,bytes]=process.argv.slice(1); process.stdout.write(`${JSON.stringify({schema:"control-room.bootstrap/v1",commit,remoteUrl,git,node:{version,archive,sha256,bytes:Number(bytes)}})}\n`);' \
  "$commit" "$REMOTE_URL" "$GIT" "$NODE_VERSION" "$NODE_ARCHIVE_NAME" "$NODE_ARCHIVE_SHA256" "$NODE_ARCHIVE_BYTES" \
  > "$d/bootstrap.json" || refuse 'bootstrap_metadata_refused'
"$CHMOD" 600 "$d/bootstrap.json"

if [ "$testing" -eq 1 ]; then
  if [ -n "$rehearsal_config" ]; then
    "$ENV" -i LANG=C LC_ALL=C HOME=/var/empty TMPDIR="$test_tmpdir" CONTROL_ROOM_BOOTSTRAP_TESTING=1 \
      "$node_root/bin/node" "$source_root/src/updater/v1/cli.mjs" install --commit "$commit" --bootstrap "$d" \
      --rehearsal-config "$rehearsal_config" --fresh-database "$fresh_database" \
      --authenticator "$authenticator" --e2e2-evidence-log "$e2e2_evidence_log" \
      --invoking-user "$SUDO_USER" --invoking-uid "$SUDO_UID" --invoking-gid "$SUDO_GID"
  else
    "$ENV" -i LANG=C LC_ALL=C HOME=/var/empty TMPDIR="$test_tmpdir" CONTROL_ROOM_BOOTSTRAP_TESTING=1 \
      "$node_root/bin/node" "$source_root/src/updater/v1/cli.mjs" install --commit "$commit" --bootstrap "$d" \
      ${fresh_database:+--fresh-database "$fresh_database"} \
      --invoking-user "$SUDO_USER" --invoking-uid "$SUDO_UID" --invoking-gid "$SUDO_GID"
  fi
  exit $?
fi
if [ -n "$rehearsal_config" ]; then
  "$ENV" -i LANG=C LC_ALL=C HOME=/var/empty TMPDIR=/var/tmp \
    "$node_root/bin/node" "$source_root/src/updater/v1/cli.mjs" install --commit "$commit" --bootstrap "$d" \
    --rehearsal-config "$rehearsal_config" --fresh-database "$fresh_database" \
    --authenticator "$authenticator" --e2e2-evidence-log "$e2e2_evidence_log" \
    --invoking-user "$SUDO_USER" --invoking-uid "$SUDO_UID" --invoking-gid "$SUDO_GID"
else
  "$ENV" -i LANG=C LC_ALL=C HOME=/var/empty TMPDIR=/var/tmp \
    "$node_root/bin/node" "$source_root/src/updater/v1/cli.mjs" install --commit "$commit" --bootstrap "$d" \
    ${fresh_database:+--fresh-database "$fresh_database"} \
    --invoking-user "$SUDO_USER" --invoking-uid "$SUDO_UID" --invoking-gid "$SUDO_GID"
fi
