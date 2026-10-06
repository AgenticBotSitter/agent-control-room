#!/bin/sh -p
# Immutable rescue/watch guard. Plain POSIX sh plus macOS system tools only.
set -eu
umask 077
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH
unset CDPATH ENV BASH_ENV NODE_OPTIONS NODE_PATH DYLD_LIBRARY_PATH DYLD_INSERT_LIBRARIES PERL5OPT PERL5LIB PERLLIB

ROOT='/Library/Application Support/Control Room'
LAUNCHCTL=/bin/launchctl
LOCKF=/usr/bin/lockf
UNAME=/usr/bin/uname
PLUTIL=/usr/bin/plutil
STAT=/usr/bin/stat
DATE=/bin/date
SLEEP=/bin/sleep
ID=/usr/bin/id
CLOCK=/usr/bin/perl
SYNC_RECORD=/usr/bin/perl
PG_CONTROLDATA="$ROOT/runtime/pg-current/bin/pg_controldata"
LABEL_PREFIX=xyz.agentcontrolroom
PLIST_DIR=/Library/LaunchDaemons
ASSUME_YES=0

# The rehearsal uses only temp roots and fake privileged commands. A production
# invocation cannot redirect the guard with inherited variables.
if [ "${CONTROL_ROOM_GUARD_TESTING-}" = 1 ]; then
  GUARD_ROOT_INPUT=${CONTROL_ROOM_GUARD_ROOT-}
  case "/$GUARD_ROOT_INPUT/" in */../*|*/./*) exit 70 ;; esac
  GUARD_ROOT_CANONICAL=$(cd "$GUARD_ROOT_INPUT" 2>/dev/null && /bin/pwd -P) || exit 70
  [ "$GUARD_ROOT_CANONICAL" = "$GUARD_ROOT_INPUT" ] || exit 70
  # The canonical root must be a real directory, and its NAME must be one of the
  # rehearsal prefixes. `pwd -P` resolves every symlink, so a root that reached this
  # point through one has already been rewritten to its real path; requiring the
  # canonical form to equal the input is what makes a symlinked temp root a refusal
  # rather than an escape. `/Volumes/CRRehearsal` is the rehearsal disk image.
  case "$GUARD_ROOT_CANONICAL" in
    /tmp/*|/private/tmp/*|/var/folders/*|/private/var/folders/*|/Volumes/CRRehearsal/*)
      ROOT=$GUARD_ROOT_CANONICAL ;;
    *)
      # Source-checkout tests may keep scratch in the worktree. This exception
      # is derived from this script's location, never an inherited allowlist.
      GUARD_SOURCE_DIR=$(cd "$(/usr/bin/dirname "$0")" && /bin/pwd -P) || exit 70
      case "$GUARD_SOURCE_DIR" in */src/updater/v1/guard) ;; *) exit 70 ;; esac
      GUARD_WORKTREE=$(cd "$GUARD_SOURCE_DIR/../../../.." && /bin/pwd -P) || exit 70
      case "$GUARD_ROOT_CANONICAL" in
        "$GUARD_WORKTREE"/.test-tmp/guard-*) ROOT=$GUARD_ROOT_CANONICAL ;;
        *) exit 70 ;;
      esac
      ;;
  esac
  case "${CONTROL_ROOM_GUARD_TEST_BIN-}" in "$ROOT"/*)
    LAUNCHCTL="$CONTROL_ROOM_GUARD_TEST_BIN/launchctl"
    STAT="$CONTROL_ROOM_GUARD_TEST_BIN/stat"
    DATE="$CONTROL_ROOM_GUARD_TEST_BIN/date"
    SLEEP="$CONTROL_ROOM_GUARD_TEST_BIN/sleep"
    ID="$CONTROL_ROOM_GUARD_TEST_BIN/id"
    CLOCK="$CONTROL_ROOM_GUARD_TEST_BIN/clock"
    if [ -x "$CONTROL_ROOM_GUARD_TEST_BIN/sync-record" ]; then SYNC_RECORD="$CONTROL_ROOM_GUARD_TEST_BIN/sync-record"; fi
    PG_CONTROLDATA="$CONTROL_ROOM_GUARD_TEST_BIN/pg_controldata"
    ;; esac
  if [ -n "${CONTROL_ROOM_GUARD_TEST_PATH-}" ]; then
    GUARD_TEST_PATH=$(cd "$CONTROL_ROOM_GUARD_TEST_PATH" 2>/dev/null && /bin/pwd -P) || exit 70
    [ "$GUARD_TEST_PATH" = "$CONTROL_ROOM_GUARD_TEST_PATH" ] || exit 70
    case "$GUARD_TEST_PATH" in "$ROOT"/*) ;; *) exit 70 ;; esac
    PATH=$GUARD_TEST_PATH
    export PATH
    LOCKF="$PATH/lockf"
    UNAME="$PATH/uname"
  fi
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
FLIP_MAX_SECONDS=900
flip_eligible=0 flip_reverted=0

die() { /bin/echo "guard_refused:$1" >&2; exit 1; }
# launchd, plutil and BSD filesystem operations make this a Mac-only guard.
# A Linux rescue implementation needs the whole host seam, not just flock.
guard_platform=$("$UNAME" -s) || die platform_unknown
[ "$guard_platform" = Darwin ] || die unsupported_platform
[ -x "$LOCKF" ] || die lock_tool_missing

extract() { "$PLUTIL" -extract "$2" raw "$1" 2>/dev/null || die malformed_state; }
valid_id() {
  case "$1" in ""|.|..|*[!A-Za-z0-9._-]*) die invalid_id ;; esac
  [ "${#1}" -le 80 ] || die invalid_id
}
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
  # The FIXED, COMPLETE label list, spelled out in full, and that is a requirement
  # rather than a style.
  #
  # Fable finding #4 (reviews/installcompose.fable.md): a `planned` install step
  # carries no receipt, so recovery after a SIGKILL must boot out from a list fixed
  # in policy -- and that list has to include `nightly-backup` and `updater-guard`,
  # which the earlier prefix loop over `updater supervisor gateway postgres` omitted.
  # Two root daemons therefore survived a rollback and came back on the next boot.
  #
  # WHY THE LABELS ARE WRITTEN OUT RATHER THAN BUILT FROM `$LABEL_PREFIX`, which is
  # what an earlier attempt in this merge did. MEASURED: with
  # `"$LAUNCHCTL" bootout "system/$LABEL_PREFIX.$name"`, the rehearsal has nothing to
  # rewrite. `installGuardV1` substitutes the POLICY's label for each of the six LIVE
  # label strings, and a guard that never contains those strings is left naming
  # `system/xyz.agentcontrolroom.postgres` in a rehearsal that means to touch nothing
  # real. The rehearsal guard test failed on
  # `xyz.agentcontrolroom.rehearsal.updater-guard` being absent -- the bug reporting
  # itself, from the side that would have booted the production daemon.
  #
  # So each of the six labels appears literally, in the order the policy lists them,
  # and they are the same six `bootstrap_all` uses.
  if [ "$LABEL_PREFIX" = xyz.agentcontrolroom ]; then
    "$LAUNCHCTL" bootout system/xyz.agentcontrolroom.updater-guard >/dev/null 2>&1 || :
    "$LAUNCHCTL" bootout system/xyz.agentcontrolroom.updater >/dev/null 2>&1 || :
    "$LAUNCHCTL" bootout system/xyz.agentcontrolroom.nightly-backup >/dev/null 2>&1 || :
    "$LAUNCHCTL" bootout system/xyz.agentcontrolroom.gateway >/dev/null 2>&1 || :
    "$LAUNCHCTL" bootout system/xyz.agentcontrolroom.supervisor >/dev/null 2>&1 || :
    "$LAUNCHCTL" bootout system/xyz.agentcontrolroom.postgres >/dev/null 2>&1 || :
  fi
  # ... OTHERWISE the six come from `$LABEL_PREFIX`, which is the rehearsal harness.
  #
  # These two blocks are the SAME six services under two different callers, and which
  # one applies is decided by the prefix. Both spellings exist because each is required
  # by a caller the other one breaks, and this is the measured shape of that:
  #
  #   - literals only: `installGuardV1` has the six live strings to rewrite, which is
  #     what keeps a rehearsal off the production daemon (see the note above) - but the
  #     harness runs this guard DIRECTLY with `CONTROL_ROOM_GUARD_TEST_LABEL_PREFIX` and
  #     no rewriting step, so the literals are emitted verbatim.
  #   - loop only: the harness's prefix is honoured and nothing production is named -
  #     but then `installGuardV1` has nothing to rewrite, which is the failure the note
  #     above describes.
  #   - both: also wrong, and measurably so. `P11.failed-heartbeat-links` and
  #     `P9.all-links-revert` assert
  #     `doesNotMatch(serviceCalls, /system\/xyz\.agentcontrolroom\.(?!rehearsal\.)/u)`
  #     - the guard must never NAME a production label in a rehearsal - and the literal
  #     six were logged verbatim.
  #
  # So: production prefix means the literals, and an overridden prefix (which line 43
  # already constrains to `xyz.agentcontrolroom.rehearsal.*`) means the loop. A
  # rehearsal prefix CANNOT reach this branch, so this branch can only ever name
  # production labels when it really is the production install.
  #
  # MEASURED: guarding the loop with the same `[ "$LABEL_PREFIX" = ... ]` condition as
  # the literals - rather than making it the `else` - left BOTH blocks skipped under a
  # rehearsal prefix, so `bootout_all` did nothing and `guard_all_links` failed
  # `ENOENT ... launchctl.log` on a log file the guard had never written a line to.
  if [ "$LABEL_PREFIX" != xyz.agentcontrolroom ]; then
    for name in updater-guard updater nightly-backup gateway supervisor postgres; do
      "$LAUNCHCTL" bootout "system/$LABEL_PREFIX.$name" >/dev/null 2>&1 || :
    done
  fi
}

service_failed() {
  /bin/echo "Rescue could not start or confirm service $1; the same rescue can be retried." >&2
  exit 1
}

bounded_command() {
  # Keep a group leader alive until cleanup. A descendant retaining stdout must
  # not defeat the deadline, and the group ID must not be recycled before kill.
  /usr/bin/perl -MPOSIX=setpgid,WNOHANG -e '
    my $seconds = shift @ARGV;
    pipe(my $read, my $write) or exit 70;
    my $group = fork(); defined $group or exit 70;
    if ($group == 0) {
      close $read; defined setpgid(0, 0) or exit 70;
      $SIG{ALRM} = sub { kill "KILL", -$$ }; alarm($seconds + 1);
      my $tool = fork(); defined $tool or exit 70;
      if ($tool == 0) { close $write; exec @ARGV; exit 70; }
      while (waitpid($tool, WNOHANG) == 0) { select undef, undef, undef, 0.02; }
      my $status = ($? & 127) ? 128 + ($? & 127) : $? >> 8;
      syswrite($write, "$status\n"); close $write;
      sleep 3600; exit 70;
    }
    close $write;
    my $status = 70;
    eval { local $SIG{ALRM} = sub { die "deadline\n" };
      local $SIG{INT} = local $SIG{TERM} = sub { die "interrupted\n" };
      alarm $seconds; my $line = <$read>; alarm 0;
      $status = int($line) if defined $line; };
    my $expired = $@; alarm 0;
    kill "KILL", -$group; kill "KILL", $group; waitpid($group, 0);
    exit($expired ? 124 : $status);
  ' "$@"
}

start_service() {
  service_name=$1 service_plist=$2
  bounded_command 10 "$LAUNCHCTL" bootstrap system "$service_plist" >/dev/null 2>&1 || service_failed "$service_name"
}

bootstrap_all() {
  # Keep the literal production paths: installGuardV1 rewrites them for rehearsal.
  if [ "$LABEL_PREFIX" = xyz.agentcontrolroom ]; then
    start_service postgres /Library/LaunchDaemons/xyz.agentcontrolroom.postgres.plist
    start_service supervisor /Library/LaunchDaemons/xyz.agentcontrolroom.supervisor.plist
    start_service gateway /Library/LaunchDaemons/xyz.agentcontrolroom.gateway.plist
    start_service updater /Library/LaunchDaemons/xyz.agentcontrolroom.updater.plist
    start_service nightly-backup /Library/LaunchDaemons/xyz.agentcontrolroom.nightly-backup.plist
    start_service updater-guard /Library/LaunchDaemons/xyz.agentcontrolroom.updater-guard.plist
  else
    for name in postgres supervisor gateway updater nightly-backup updater-guard; do
      start_service "$name" "$PLIST_DIR/$LABEL_PREFIX.$name.plist"
    done
  fi
  # Long-running services must have a running process. Scheduled jobs may be idle,
  # but must be registered. Observe three successive samples within ten attempts.
  for name in postgres supervisor gateway updater nightly-backup updater-guard; do
    attempts=0 samples=0
    while [ "$attempts" -lt 10 ] && [ "$samples" -lt 3 ]; do
      attempts=$((attempts + 1))
      if health=$(bounded_command 2 "$LAUNCHCTL" print "system/$LABEL_PREFIX.$name" 2>/dev/null); then
        case "$name" in
          nightly-backup|updater-guard) samples=$((samples + 1)) ;;
          *) if /bin/echo "$health" | /usr/bin/grep -Eq '^[[:space:]]*state = running$' &&
                  /bin/echo "$health" | /usr/bin/grep -Eq '^[[:space:]]*pid = [1-9][0-9]*$'; then
               samples=$((samples + 1))
             else samples=0; fi ;;
        esac
      else samples=0; fi
      [ "$samples" -ge 3 ] || "$SLEEP" 1
    done
    [ "$samples" -ge 3 ] || service_failed "$name"
  done
}

artifact_refused() {
  # TWO LINES, the first one the status and the second one the reason.
  #
  # THE OLD TEXT WAS FALSE for every refusal that was not a missing file. It said
  # "the backup copy is missing or incomplete", so an ownership or mode refusal
  # sent the owner to repair a backup copy that was perfectly intact, and the real
  # cause — a wrong expectation inside this guard, or a path it cannot trust — was
  # never named. A refusal that does not name its cause is indistinguishable from
  # data loss, and the owner's only correct response to those is different.
  /bin/echo 'rescue stopped nothing and changed no selected version or database; current service state was not checked' >&2
  /bin/echo "rescue cannot continue: $1" >&2
  exit 1
}

# The path as the owner knows it, so a refusal names something they can look at
# rather than an absolute path under a root they never type. `$ROOT` itself is
# `.` rather than the empty string, which would read as a broken sentence.
artifact_relative() {
  if [ "$1" = "$ROOT" ]; then printf '%s' ".";
  else case "$1" in
    "$ROOT"/*) printf '%s' "${1#"$ROOT"/}" ;;
    *) printf '%s' "$1" ;;
  esac
  fi
}

artifact_custody() {
  artifact=$1 owner=$2 kind=$3 held_by=${4:-"uid $2"}
  where=$(artifact_relative "$artifact")
  [ ! -L "$artifact" ] || artifact_refused "$where is a link, not a real $kind"
  # "Missing" and "the wrong kind of thing" are DIFFERENT refusals, and the old
  # single message merged them, which is how a refusal about a directory's owner
  # could be read as a refusal about a missing file. Split on purpose.
  if [ "$kind" = directory ]; then
    if [ ! -d "$artifact" ]; then
      if [ -e "$artifact" ]; then artifact_refused "$where is a file, but a folder is required";
      else artifact_refused "$where is missing"; fi
    fi
  else
    if [ ! -f "$artifact" ] || [ ! -s "$artifact" ]; then
      if [ -e "$artifact" ]; then artifact_refused "$where is not a regular file with content in it";
      else artifact_refused "$where is missing or empty"; fi
    fi
  fi
  metadata=$("$STAT" -f '%u %Lp' "$artifact" 2>/dev/null) \
    || artifact_refused "the owner and permissions of $where could not be read"
  artifact_uid=${metadata%% *}; artifact_mode=${metadata#* }
  [ "$artifact_uid" = "$owner" ] \
    || artifact_refused "$where is owned by uid $artifact_uid, but it must be owned by $held_by"
  case "$artifact_mode" in ''|*[!0-7]*) artifact_refused "the permissions of $where could not be read" ;; esac
  # No group/world writes or special bits in a saved pair.
  if [ "$artifact_mode" -gt 777 ] || [ $((0$artifact_mode & 022)) -ne 0 ]; then
    artifact_refused "$where is mode $artifact_mode; a saved copy must not be group- or world-writable"
  fi
}

validate_rescue_pair() {
  # The configured, root-held PostgreSQL plist identifies the database account,
  # including a rehearsal's isolated account. Never trust a ledger-supplied owner.
  #
  # `--` before the account name is REQUIRED, not decoration. MEASURED: `id -u -r`
  # prints the invoking uid and exits 0, and `id -u -n` prints the login NAME and
  # exits 0, so a plist whose `UserName` began with a dash made `db_uid` resolve to
  # something other than the database account. Under root that is `0` — which is
  # precisely the wrong-owner expectation this function exists to express, so a
  # single corrupt `UserName` would refuse every rescue on the Mac again.
  if [ "$LABEL_PREFIX" = xyz.agentcontrolroom ]; then
    db_plist=/Library/LaunchDaemons/xyz.agentcontrolroom.postgres.plist
  else db_plist="$PLIST_DIR/$LABEL_PREFIX.postgres.plist"; fi
  db_account=$("$PLUTIL" -extract UserName raw "$db_plist" 2>/dev/null) \
    || artifact_refused "the postgres service definition $(artifact_relative "$db_plist") could not be read"
  db_uid=$("$ID" -u -- "$db_account" 2>/dev/null) \
    || artifact_refused "the database account named in the postgres service definition could not be resolved to a uid"
  case "$db_uid" in ''|*[!0-9]*)
    artifact_refused "the database account named in the postgres service definition did not resolve to a numeric uid" ;;
  esac
  db_owner="the database account ($db_account, uid $db_uid)"
  artifact_custody "$ROOT" 0 directory root
  artifact_custody "$ROOT/releases" 0 directory root
  # `pg/` BELONGS TO THE DATABASE ACCOUNT, and expecting root here refuses every
  # rescue on every real installation. `chownOwnershipV1` hands `pg/` to `D` so
  # the postmaster can traverse into its own tree, `applyOwnershipV1` reads the
  # owner back and refuses if it is anything else, and nothing in the codebase
  # ever chowns it back to root.
  artifact_custody "$ROOT/pg" "$db_uid" directory "$db_owner"
  # `pg/socket` is a live directory holding the Unix socket: the installer gives
  # it to `D` (with the service group so the web process can reach the socket) and
  # nothing enumerated it, so a link planted there was not refused.
  artifact_custody "$ROOT/pg/socket" "$db_uid" directory "$db_owner"
  artifact_custody "$ROOT/releases/$release" 0 directory root
  for directory in scripts scripts/mac-local dist-vps dist-vps/server; do
    artifact_custody "$ROOT/releases/$release/$directory" 0 directory root
  done
  for file in RELEASE_MANIFEST.json package.json scripts/mac-local/task-host-supervisor.mjs dist-vps/server/fleetGateway.js dist-vps/server/nightlyBackup.js; do
    artifact_custody "$ROOT/releases/$release/$file" 0 file root
  done
  artifact_custody "$ROOT/pg/data-$pg" "$db_uid" directory "$db_owner"
  for directory in base global pg_wal pg_wal/archive_status; do
    artifact_custody "$ROOT/pg/data-$pg/$directory" "$db_uid" directory "$db_owner"
  done
  for file in PG_VERSION global/pg_control pg_hba.conf pg_ident.conf postgresql.conf; do
    artifact_custody "$ROOT/pg/data-$pg/$file" "$db_uid" file "$db_owner"
  done
}

heartbeat_stale() {
  [ -f "$HEARTBEAT" ] || return 0
  now=$("$DATE" +%s); changed=$("$STAT" -f %m "$HEARTBEAT" 2>/dev/null || /bin/echo 0)
  [ "$changed" -le "$now" ] && [ $((now - changed)) -gt 180 ]
}

sync_flip_record() {
  "$SYNC_RECORD" -MIO::Handle -MFcntl=:DEFAULT -e '
    for my $path (@ARGV) {
      sysopen(my $handle, $path, O_RDONLY | O_NOFOLLOW) or exit 1;
      $handle->sync or exit 1;
      close($handle) or exit 1;
    }' "$1" || die selfupgrade_record_failed
}

write_flip_record() {
  flip_phase=$1 flip_reason=$2 flip_state=$3
  temp="$STATE/.selfupgrade.json.$$"
  "$PLUTIL" -convert json -o "$temp" "$SELFUPGRADE" || die selfupgrade_record_failed
  "$PLUTIL" -replace phase -string "$flip_phase" "$temp" || die selfupgrade_record_failed
  "$PLUTIL" -remove reason "$temp" >/dev/null 2>&1 || :
  "$PLUTIL" -remove state "$temp" >/dev/null 2>&1 || :
  "$PLUTIL" -insert reason -string "$flip_reason" "$temp" || die selfupgrade_record_failed
  "$PLUTIL" -insert state -string "$flip_state" "$temp" || die selfupgrade_record_failed
  /bin/chmod 600 "$temp"; sync_flip_record "$temp"
  /bin/mv -f "$temp" "$SELFUPGRADE"; sync_flip_record "$STATE"
}

settle_upgrade_attempt() {
  flip_eligible=0
  [ -f "$SELFUPGRADE" ] || return 0
  schema=$(extract "$SELFUPGRADE" schema)
  [ "$schema" = control-room.selfupgrade/v1 ] || die invalid_selfupgrade
  phase=$(extract "$SELFUPGRADE" phase)
  case "$phase" in flipping|reverting) ;; *) return 0 ;; esac
  artifact_custody "$SELFUPGRADE" 0 file root
  record_boot=$("$PLUTIL" -extract bootId raw "$SELFUPGRADE" 2>/dev/null || :)
  attempt=$("$PLUTIL" -extract attemptId raw "$SELFUPGRADE" 2>/dev/null || :)
  started=$("$PLUTIL" -extract startedMono raw "$SELFUPGRADE" 2>/dev/null || :)
  health=$("$PLUTIL" -extract healthPassed raw "$SELFUPGRADE" 2>/dev/null || :)
  reason=updater_selfupgrade_unproven
  if [ -n "$record_boot" ] && [ -n "$attempt" ] && [ -f "$STATE/selfupgrade-attempt.json" ]; then
    artifact_custody "$STATE/selfupgrade-attempt.json" 0 file root
    active_schema=$("$PLUTIL" -extract schema raw "$STATE/selfupgrade-attempt.json" 2>/dev/null || :)
    active_attempt=$("$PLUTIL" -extract attemptId raw "$STATE/selfupgrade-attempt.json" 2>/dev/null || :)
    active_boot=$("$PLUTIL" -extract bootId raw "$STATE/selfupgrade-attempt.json" 2>/dev/null || :)
    active_started=$("$PLUTIL" -extract startedMono raw "$STATE/selfupgrade-attempt.json" 2>/dev/null || :)
    if [ "$health" = true ]; then reason=updater_selfupgrade_healthy
    elif [ "$record_boot" != "$boot" ]; then reason=updater_selfupgrade_previous_boot
    elif [ "$active_schema" != control-room.selfupgrade-attempt/v1 ] || [ "$active_attempt" != "$attempt" ] \
      || [ "$active_boot" != "$record_boot" ] || [ "$active_started" != "$started" ]; then reason=updater_selfupgrade_superseded
    else
      case "$started" in ''|*[!0-9]*) reason=updater_selfupgrade_unproven ;;
        *) if [ "${#started}" -gt 10 ] || [ "$now" -lt "$started" ] || [ $((now - started)) -gt "$FLIP_MAX_SECONDS" ]; then
             reason=updater_selfupgrade_expired
           elif [ "$health" = false ]; then reason=eligible; fi ;;
      esac
    fi
  fi
  if [ "$reason" != eligible ]; then
    if [ "$phase" = reverting ]; then write_flip_record settled updater_selfupgrade_reverted needs_attention
    else write_flip_record settled "$reason" settled; fi
    return 0
  fi
  count=$(extract "$SELFUPGRADE" linkCount)
  /bin/echo "$count" | /usr/bin/grep -Eq '^[1-5]$' || die invalid_link_count
  index=0 seen='|' changed_links=0
  # Validate the complete link set before changing any pointer.
  while [ "$index" -lt "$count" ]; do
    link=$(extract "$SELFUPGRADE" "links.$index.link")
    from=$(extract "$SELFUPGRADE" "links.$index.from")
    to=$(extract "$SELFUPGRADE" "links.$index.to")
    valid_link "$link"; valid_id "$from"; valid_id "$to"
    case "$seen" in *"|$link|"*) die duplicate_flip_link ;; esac
    seen="$seen$link|"
    current=$(/usr/bin/readlink "$ROOT/$link") || die invalid_flip_link
    if [ "$current" != "$from" ] && [ "$current" != "$to" ]; then
      if [ "$phase" = reverting ]; then write_flip_record settled updater_selfupgrade_reverted needs_attention
      else write_flip_record settled updater_selfupgrade_links_moved settled; fi
      return 0
    fi
    [ "$current" = "$from" ] || changed_links=$((changed_links + 1))
    index=$((index + 1))
  done
  if [ "$changed_links" -eq 0 ] && [ "$phase" = flipping ]; then
    write_flip_record settled updater_selfupgrade_no_links_moved settled
    return 0
  fi
  flip_eligible=1
}

revert_upgrade_links() {
  settle_upgrade_attempt
  [ "$flip_eligible" = 1 ] || return 0
  # The intent is owner-visible before the first move, even after a power cut.
  write_flip_record reverting updater_selfupgrade_reverted needs_attention
  /bin/echo 'The updater is returning to the previous runtime after an unhealthy self-update. Review recovery on the Mac before retrying.' >&2
  index=0
  while [ "$index" -lt "$count" ]; do
    link=$(extract "$SELFUPGRADE" "links.$index.link")
    from=$(extract "$SELFUPGRADE" "links.$index.from")
    atomic_link "$link" "$from"
    index=$((index + 1))
  done
  write_flip_record reverted updater_selfupgrade_reverted needs_attention
  flip_reverted=1
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

write_rescue_receipt() {
  at=$("$DATE" -u +%Y-%m-%dT%H:%M:%SZ)
  valid_id "$current_release"; valid_id "$current_pg"
  temp="$STATE/.rescued.json.$$"
  /usr/bin/printf '%s\n' "{\"schema\":\"control-room.rescued/v1\",\"serviceState\":\"$rescue_service_state\",\"at\":\"$at\",\"from\":{\"releaseId\":\"$current_release\",\"pgDataId\":\"$current_pg\",\"schemaDigest\":$current_digest_json},\"to\":{\"releaseId\":\"$release\",\"pgDataId\":\"$pg\",\"schemaDigest\":\"$digest\"}}" >"$temp"
  /bin/chmod 600 "$temp"; /bin/mv -f "$temp" "$STATE/rescued.json"
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
  intent="$STATE/rescue-intent.json"
  if [ -f "$intent" ]; then
    [ "$(extract "$intent" schema)" = control-room.rescue-intent/v1 ] || die invalid_rescue_intent
    release=$(extract "$intent" to.releaseId); pg=$(extract "$intent" to.pgDataId)
    digest=$(extract "$intent" to.schemaDigest)
    valid_id "$release"; valid_id "$pg"
    index=0
    while [ "$index" -lt "$count" ]; do
      if [ "$(extract "$KNOWN" "pairs.$index.releaseId")" = "$release" ] &&
         [ "$(extract "$KNOWN" "pairs.$index.pgDataId")" = "$pg" ] &&
         [ "$(extract "$KNOWN" "pairs.$index.schemaDigest")" = "$digest" ]; then selected=$index; break; fi
      index=$((index + 1))
    done
    [ "$selected" -ge 0 ] || die invalid_rescue_intent
    current_release=$(extract "$intent" from.releaseId); current_pg=$(extract "$intent" from.pgDataId)
    current_digest_json=$(extract "$intent" from.schemaDigest)
    if [ "$current_digest_json" != null ]; then
      /bin/echo "$current_digest_json" | /usr/bin/grep -Eq '^sha256:[a-f0-9]{64}$' || die invalid_schema_digest
      current_digest_json="\"$current_digest_json\""
    fi
  elif [ "$current_index" -gt 0 ]; then selected=$((current_index - 1));
  elif [ "$current_index" -lt 0 ]; then selected=$((count - 1)); fi
  [ "$selected" -ge 0 ] || die no_older_pair
  release=$(extract "$KNOWN" "pairs.$selected.releaseId")
  pg=$(extract "$KNOWN" "pairs.$selected.pgDataId")
  digest=$(extract "$KNOWN" "pairs.$selected.schemaDigest")
  valid_id "$release"; valid_id "$pg"
  /bin/echo "$digest" | /usr/bin/grep -Eq '^sha256:[a-f0-9]{64}$' || die invalid_schema_digest
  validate_rescue_pair
  if [ ! -f "$intent" ] && [ "$pg" != "$current_pg" ] && [ "$ASSUME_YES" != 1 ]; then
    /bin/echo 'This rescue selects an older database and loses newer data. Type YES to continue:' >&2
    IFS= read -r answer || die owner_declined_data_loss; [ "$answer" = YES ] || die owner_declined_data_loss
  fi
  valid_id "$current_release"; valid_id "$current_pg"
  if [ ! -f "$intent" ]; then
    temp="$STATE/.rescue-intent.$$"
    /usr/bin/printf '%s\n' "{\"schema\":\"control-room.rescue-intent/v1\",\"from\":{\"releaseId\":\"$current_release\",\"pgDataId\":\"$current_pg\",\"schemaDigest\":$current_digest_json},\"to\":{\"releaseId\":\"$release\",\"pgDataId\":\"$pg\",\"schemaDigest\":\"$digest\"}}" >"$temp"
    /bin/chmod 600 "$temp"; /bin/sync; /bin/mv -f "$temp" "$intent"; /bin/sync
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
  elapsed_clock
  if heartbeat_stale; then revert_upgrade_links; else settle_upgrade_attempt; fi
  rescue_service_state=starting_services
  write_rescue_receipt
  # The rescue is authoritative. Retain any interrupted switch as evidence,
  # but move it out of the startup recovery path before services are restarted.
  if [ -e "$STATE/link-switch.json" ] || [ -L "$STATE/link-switch.json" ]; then
    /bin/mv -f "$STATE/link-switch.json" "$STATE/link-switch.rescued.json"
  fi
  /bin/sync
  bootstrap_all
  rescue_service_state=completed
  write_rescue_receipt
  /bin/sync
  /bin/rm -f "$intent"; /bin/sync
  [ "$flip_reverted" = 0 ] || die selfupgrade_reverted
}

write_guard_status() {
  status_at=$("$DATE" +%s)
  temp="$STATE/.guard-status.json.$$"
  /usr/bin/printf '%s\n' "{\"schema\":\"control-room.guard-status/v1\",\"updaterRestartsLastHour\":$recent,\"at\":$status_at}" >"$temp"
  /bin/chmod 600 "$temp"; /bin/mv -f "$temp" "$STATE/guard-status.json"
}

elapsed_clock() {
  if [ "${CONTROL_ROOM_GUARD_TESTING-}" = 1 ]; then
    clock_value=$("$CLOCK") || die elapsed_clock_unavailable
  else
    # System Perl exposes mach's monotonic clock; boot identity prevents mixing
    # observations or restart budgets across reboots. No wall-clock fallback.
    elapsed=$("$CLOCK" -MTime::HiRes=clock_gettime,CLOCK_MONOTONIC -e 'print int(clock_gettime(CLOCK_MONOTONIC))') || die elapsed_clock_unavailable
    boot=$(/usr/sbin/sysctl -n kern.bootsessionuuid 2>/dev/null) || die elapsed_clock_unavailable
    clock_value="$boot $elapsed"
  fi
  boot=${clock_value%% *}; now=${clock_value#* }
  valid_id "$boot"
  case "$now" in ''|*[!0-9]*) die elapsed_clock_unavailable ;; esac
}

watch() {
  elapsed_clock
  watch_refused=0
  if [ -f "$SELFUPGRADE" ]; then
    shape_schema=$("$PLUTIL" -extract schema raw "$SELFUPGRADE" 2>/dev/null || :)
    shape_phase=$("$PLUTIL" -extract phase raw "$SELFUPGRADE" 2>/dev/null || :)
    if [ "$shape_schema" != control-room.selfupgrade/v1 ] || [ -z "$shape_phase" ]; then
      watch_refused=1
      /bin/echo guard_refused:malformed_state >&2
    fi
  fi
  # Damaged evidence cannot authorize a move or disable an ordinary restart.
  if [ "$watch_refused" = 0 ]; then settle_upgrade_attempt; fi
  recent=0
  if [ -f "$RESTARTS" ]; then
    recent=$(/usr/bin/awk -v boot="$boot" -v cutoff=$((now - 3600)) -v now="$now" '$1 == boot && $2 ~ /^[0-9]+$/ && $2 > cutoff && $2 <= now {n++} END {print n+0}' "$RESTARTS")
  fi
  write_guard_status
  changed=missing
  if [ -f "$HEARTBEAT" ]; then changed=$("$STAT" -f %m "$HEARTBEAT" 2>/dev/null) || die heartbeat_stat_failed; fi
  case "$changed" in missing) ;; ''|*[!0-9]*) die invalid_heartbeat_time ;; esac
  observation="$STATE/guard-heartbeat-observed"
  observed_boot=none observed=0 observed_change=none
  if [ -f "$observation" ]; then
    IFS=' ' read -r observed_boot observed observed_change <"$observation" || die invalid_heartbeat_observation
    case "$observed" in ''|*[!0-9]*) die invalid_heartbeat_observation ;; esac
  fi
  # A changed heartbeat, reboot, unavailable previous observation or elapsed
  # clock reset gives one full heartbeat window. Even a forward wall jump cannot
  # declare a hang until we independently observe the unchanged heartbeat.
  if [ "$observed_boot" != "$boot" ] || [ "$observed_change" != "$changed" ] || [ "$now" -lt "$observed" ]; then
    temp="$STATE/.heartbeat-observed.$$"
    /usr/bin/printf '%s %s %s\n' "$boot" "$now" "$changed" >"$temp"
    /bin/mv -f "$temp" "$observation"
    [ "$watch_refused" = 0 ] || die malformed_state
    return 0
  fi
  if [ $((now - observed)) -le 180 ]; then
    [ "$watch_refused" = 0 ] || die malformed_state
    return 0
  fi
  if [ "$recent" -ge 3 ]; then
    /bin/echo 'The updater restart allowance is exhausted; retry after one hour or use rescue.' >&2
    die restart_limit
  fi
  if [ "$watch_refused" = 0 ]; then revert_upgrade_links; fi
  /usr/bin/printf '%s %s\n' "$boot" "$now" >>"$RESTARTS"
  recent=$((recent + 1)); write_guard_status
  "$LAUNCHCTL" kickstart -k "system/$LABEL_PREFIX.updater" >/dev/null 2>&1 || die kickstart_failed
  [ "$watch_refused" = 0 ] || die malformed_state
  [ "$flip_reverted" = 0 ] || die selfupgrade_reverted
}

case "${1-watch}" in rescue) "$LOCKF" -k -s -t 0 "$STATE/guard.lock" /bin/sh -p "$0" rescue-locked ;; rescue-locked) rescue ;; watch) "$LOCKF" -k -s -t 0 "$STATE/guard.lock" /bin/sh -p "$0" watch-locked ;; watch-locked) watch ;; *) die invalid_verb ;; esac
