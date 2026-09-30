#!/bin/sh -p
# Immutable rescue/watch guard. Plain POSIX sh plus macOS system tools only.
set -eu
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
unset CDPATH ENV BASH_ENV NODE_OPTIONS NODE_PATH DYLD_LIBRARY_PATH DYLD_INSERT_LIBRARIES

ROOT='/Library/Application Support/Control Room'
LAUNCHCTL=/bin/launchctl
PLUTIL=/usr/bin/plutil
STAT=/usr/bin/stat
DATE=/bin/date
SLEEP=/bin/sleep
PG_CONTROLDATA="$ROOT/runtime/pg-current/bin/pg_controldata"
LABEL_PREFIX=xyz.agentcontrolroom
PLIST_DIR=/Library/LaunchDaemons
ASSUME_YES=0

# The rehearsal uses only temp roots and fake privileged commands. A production
# invocation cannot redirect the guard with inherited variables.
if [ "${CONTROL_ROOM_GUARD_TESTING-}" = 1 ]; then
  case "${CONTROL_ROOM_GUARD_ROOT-}" in /tmp/*|/private/tmp/*|/Volumes/CRRehearsal/*) ROOT=$CONTROL_ROOM_GUARD_ROOT ;; *) exit 70 ;; esac
  case "${CONTROL_ROOM_GUARD_TEST_BIN-}" in "$ROOT"/*)
    LAUNCHCTL="$CONTROL_ROOM_GUARD_TEST_BIN/launchctl"
    STAT="$CONTROL_ROOM_GUARD_TEST_BIN/stat"
    DATE="$CONTROL_ROOM_GUARD_TEST_BIN/date"
    SLEEP="$CONTROL_ROOM_GUARD_TEST_BIN/sleep"
    PG_CONTROLDATA="$CONTROL_ROOM_GUARD_TEST_BIN/pg_controldata"
    ;; esac
  if [ -n "${CONTROL_ROOM_GUARD_TEST_LABEL_PREFIX-}" ]; then
    /bin/echo "$CONTROL_ROOM_GUARD_TEST_LABEL_PREFIX" | /usr/bin/grep -Eq '^xyz\.agentcontrolroom\.rehearsal\.[A-Za-z0-9._-]{1,49}$' || exit 70
    LABEL_PREFIX=$CONTROL_ROOM_GUARD_TEST_LABEL_PREFIX
    PLIST_DIR="$ROOT/fake-plists"
  fi
  [ "${CONTROL_ROOM_GUARD_ASSUME_YES-}" = 1 ] && ASSUME_YES=1
fi

STATE="$ROOT/updater-state"
KNOWN="$STATE/known-good"
SELFUPGRADE="$STATE/selfupgrade.json"
HEARTBEAT="$STATE/heartbeat"
RESTARTS="$STATE/guard-restarts.log"

die() { /bin/echo "guard_refused:$1" >&2; exit 1; }
extract() { "$PLUTIL" -extract "$2" raw "$1" 2>/dev/null || die malformed_state; }
valid_id() { /bin/echo "$1" | /usr/bin/grep -Eq '^[A-Za-z0-9._-]{1,80}$' || die invalid_id; }
valid_link() {
  case "$1" in updater/current|runtime/node-current|runtime/pnpm-current|runtime/pg-current|runtime/esbuild-current) ;;
    *) die invalid_link ;; esac
}

atomic_link() {
  link=$1 target=$2
  valid_id "$target"
  parent=${link%/*}; name=${link##*/}; temp="$ROOT/$parent/.$name.guard.$$"
  [ ! -L "$ROOT/$parent" ] || die symlink_parent
  [ -d "$ROOT/$parent" ] || die missing_parent
  /bin/rm -f "$temp"
  /bin/ln -s "$target" "$temp"
  /bin/mv -f -h "$temp" "$ROOT/$link"
}

bootout_all() {
  for name in updater supervisor gateway postgres; do
    "$LAUNCHCTL" bootout "system/$LABEL_PREFIX.$name" >/dev/null 2>&1 || :
  done
}

bootstrap_all() {
  for name in postgres supervisor gateway updater; do
    "$LAUNCHCTL" bootstrap system "$PLIST_DIR/$LABEL_PREFIX.$name.plist" >/dev/null 2>&1 || :
  done
}

heartbeat_stale() {
  [ -f "$HEARTBEAT" ] || return 0
  now=$("$DATE" +%s); changed=$("$STAT" -f %m "$HEARTBEAT" 2>/dev/null || /bin/echo 0)
  [ $((now - changed)) -gt 180 ]
}

revert_upgrade_links() {
  [ -f "$SELFUPGRADE" ] || return 0
  schema=$(extract "$SELFUPGRADE" schema)
  [ "$schema" = control-room.selfupgrade/v1 ] || die invalid_selfupgrade
  phase=$(extract "$SELFUPGRADE" phase)
  [ "$phase" = flipping ] || return 0
  count=$(extract "$SELFUPGRADE" linkCount)
  /bin/echo "$count" | /usr/bin/grep -Eq '^[1-5]$' || die invalid_link_count
  index=0
  while [ "$index" -lt "$count" ]; do
    link=$(extract "$SELFUPGRADE" "links.$index.link")
    from=$(extract "$SELFUPGRADE" "links.$index.from")
    valid_link "$link"; valid_id "$from"
    atomic_link "$link" "$from"
    index=$((index + 1))
  done
}

wait_postgres_stopped() {
  loops=0
  while [ -e "$ROOT/pg/current/postmaster.pid" ] && [ "$loops" -lt 120 ]; do
    "$SLEEP" 1; loops=$((loops + 1))
  done
  [ ! -e "$ROOT/pg/current/postmaster.pid" ] || die postgres_still_running
  # A socket surviving bootout means the cluster has not actually stopped.
  for socket in "$ROOT"/pg/socket/.s.PGSQL.*; do
    [ ! -S "$socket" ] || die postgres_socket_still_open
  done
  [ -x "$PG_CONTROLDATA" ] || die pg_controldata_missing
  "$PG_CONTROLDATA" "$ROOT/pg/current" | /usr/bin/grep -Eq 'Database cluster state:[[:space:]]+shut down' \
    || die postgres_not_shut_down
}

rescue() {
  schema=$(extract "$KNOWN" schema); [ "$schema" = control-room.known-good/v1 ] || die invalid_known_good
  count=$(extract "$KNOWN" count); /bin/echo "$count" | /usr/bin/grep -Eq '^[1-3]$' || die invalid_pair_count
  current_release=$(/usr/bin/basename "$(/usr/bin/readlink "$ROOT/current" 2>/dev/null || /bin/echo none)")
  current_pg=$(/usr/bin/basename "$(/usr/bin/readlink "$ROOT/pg/current" 2>/dev/null || /bin/echo none)")
  current_pg=${current_pg#data-}
  selected=-1
  current_index=-1
  current_digest_json=null
  index=0
  while [ "$index" -ge 0 ]; do
    [ "$index" -lt "$count" ] || break
    release=$(extract "$KNOWN" "pairs.$index.releaseId")
    pg=$(extract "$KNOWN" "pairs.$index.pgDataId")
    digest=$(extract "$KNOWN" "pairs.$index.schemaDigest")
    valid_id "$release"; valid_id "$pg"
    /bin/echo "$digest" | /usr/bin/grep -Eq '^sha256:[a-f0-9]{64}$' || die invalid_schema_digest
    if [ "$release" = "$current_release" ] && [ "$pg" = "$current_pg" ]; then
      current_index=$index; current_digest_json="\"$digest\""
    fi
    index=$((index + 1))
  done
  if [ "$current_index" -gt 0 ]; then selected=$((current_index - 1));
  elif [ "$current_index" -lt 0 ]; then selected=$((count - 1)); fi
  [ "$selected" -ge 0 ] || die no_older_pair
  release=$(extract "$KNOWN" "pairs.$selected.releaseId")
  pg=$(extract "$KNOWN" "pairs.$selected.pgDataId")
  digest=$(extract "$KNOWN" "pairs.$selected.schemaDigest")
  valid_id "$release"; valid_id "$pg"
  /bin/echo "$digest" | /usr/bin/grep -Eq '^sha256:[a-f0-9]{64}$' || die invalid_schema_digest
  if [ "$pg" != "$current_pg" ] && [ "$ASSUME_YES" != 1 ]; then
    /bin/echo 'This rescue selects an older database and loses newer data. Type YES to continue:' >&2
    IFS= read -r answer; [ "$answer" = YES ] || die owner_declined_data_loss
  fi
  # Validate the complete source and destination pair, including owner consent,
  # before stopping a service. Refusal must leave the running pair untouched.
  bootout_all
  wait_postgres_stopped
  # Both services are down. Flip the database and code as one recorded pair
  # before anything is bootstrapped; no mixed pair is ever started.
  atomic_link pg/current "data-$pg"
  [ ! -L "$ROOT" ] || die symlink_root
  temp="$ROOT/.current.guard.$$"; /bin/rm -f "$temp"; /bin/ln -s "releases/$release" "$temp"; /bin/mv -f -h "$temp" "$ROOT/current"
  if heartbeat_stale; then revert_upgrade_links; fi
  at=$("$DATE" -u +%Y-%m-%dT%H:%M:%SZ)
  valid_id "$current_release"; valid_id "$current_pg"
  temp="$STATE/.rescued.json.$$"
  /usr/bin/printf '%s\n' "{\"schema\":\"control-room.rescued/v1\",\"at\":\"$at\",\"from\":{\"releaseId\":\"$current_release\",\"pgDataId\":\"$current_pg\",\"schemaDigest\":$current_digest_json},\"to\":{\"releaseId\":\"$release\",\"pgDataId\":\"$pg\",\"schemaDigest\":\"$digest\"}}" >"$temp"
  /bin/chmod 600 "$temp"; /bin/mv -f "$temp" "$STATE/rescued.json"
  bootstrap_all
}

watch() {
  heartbeat_stale || exit 0
  now=$("$DATE" +%s)
  recent=0
  if [ -f "$RESTARTS" ]; then recent=$(/usr/bin/awk -v cutoff=$((now - 3600)) '$1 >= cutoff {n++} END {print n+0}' "$RESTARTS"); fi
  [ "$recent" -lt 3 ] || die restart_limit
  revert_upgrade_links
  /usr/bin/printf '%s\n' "$now" >>"$RESTARTS"
  temp="$STATE/.guard-status.json.$$"
  /usr/bin/printf '%s\n' "{\"schema\":\"control-room.guard-status/v1\",\"updaterRestartsLastHour\":$((recent + 1)),\"at\":$now}" >"$temp"
  /bin/chmod 600 "$temp"; /bin/mv -f "$temp" "$STATE/guard-status.json"
  "$LAUNCHCTL" kickstart -k "system/$LABEL_PREFIX.updater" >/dev/null 2>&1 || die kickstart_failed
}

case "${1-watch}" in rescue) rescue ;; watch) watch ;; *) die invalid_verb ;; esac
