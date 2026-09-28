#!/usr/bin/env bash
# Nightly backup of the VPS stack (docker-compose.vps.yml). Run by the systemd timer in
# deploy/systemd/ (vio-backup.timer, ~03:17 UTC; output appended to /var/log/vio-backup.log).
#
#   /var/backups/vio/db/db-YYYYmmdd-HHMM.dump  pg_dump -Fc (UTC time), mode 600, kept 14 days
#   /var/backups/vio/storage/<bucket>/          mirror of the object store, except try-it
#                                               uploads (public/try/, deleted after 24 h anyway)
#   /var/backups/vio/storage/.deleted/<date>/   what that day's run dropped from the mirror
#                                               (erased or overwritten in the bucket), kept 13
#                                               days: an erased object leaves the mirror within
#                                               a day, so it is in no backup after 14 days
#   RCLONE_REMOTE=<remote:path>                 optional: also sync db/ and storage/ to an
#                                               off-host rclone remote (e.g. an encrypted R2
#                                               bucket), same policy
#
# Expired files are pruned first, so retention holds even on nights when a later step fails
# (the off-host copy is then still synced, to carry the prune there too).
# The mirror won't sync from an empty bucket and stops after BACKUP_MAX_DELETE deletions
# (default: half the mirror, at least 100), so a lost and recreated storage volume can't
# empty it. The run also stops while less than MIN_FREE_GB (5) would be left on the disk.
# `backup.sh restore-storage [<YYYYmmdd> [<prefix>]]` copies the mirror, or one day of
# .deleted, back into the bucket (see README, Backups).
# Storage credentials are read from .env (STORAGE_ACCESS_KEY / STORAGE_SECRET_KEY), passed
# to rclone through the environment and never printed. Prints one summary line; exits
# non-zero when any step fails.
set -Eeuo pipefail
umask 077

APP_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
COMPOSE_FILE=${COMPOSE_FILE:-$APP_DIR/docker-compose.vps.yml}
ENV_FILE=${ENV_FILE:-$APP_DIR/.env}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/vio}
RETENTION_DAYS=${RETENTION_DAYS:-14}
MIN_FREE_GB=${MIN_FREE_GB:-5} # the databases share this disk; a full disk stops them
BUCKET=${BACKUP_BUCKET:-vio-images} # S3_BUCKET in docker-compose.vps.yml
RCLONE_IMAGE=${RCLONE_IMAGE:-rclone/rclone:1.74.4}
RCLONE_CONFIG_DIR=${RCLONE_CONFIG_DIR:-/root/.config/rclone}
RCLONE_REMOTE=${RCLONE_REMOTE:-}
TRY_FILTER="/public/try/**" # try-it uploads (TRY_PREFIX in app/lib/try.server.ts)

step="start"
pruned=0
exec 3>&1 # log lines go to the original stdout, even from inside a redirected command
log() { printf '%s vio-backup %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >&3; }

# sync (not copy) to the off-host remote, so expired dumps and pruned days go there too.
offsite_sync() {
  local part
  for part in db storage; do
    docker run --rm -v "$RCLONE_CONFIG_DIR:/config/rclone:ro" -v "$BACKUP_DIR:/backup:ro" \
      "$RCLONE_IMAGE" sync "/backup/$part" "$RCLONE_REMOTE/$part" --exclude "*.partial" --fast-list --transfers 4
  done
}
# A failed run has still pruned; bring the off-host copy's retention in line as well.
offsite_after_failure() {
  if [ "$pruned" = 1 ] && [ -n "$RCLONE_REMOTE" ] && [ "$step" != "off-host copy" ] &&
    [ -f "$RCLONE_CONFIG_DIR/rclone.conf" ]; then
    offsite_sync || log "off-host sync after the failure also failed"
  fi
}
fail() {
  log "FAILED during ${step}: $*"
  offsite_after_failure
  exit 1
}
on_error() {
  local rc=$?
  # Subshells ($(...), pipelines) inherit the trap; report once, from the main shell.
  if [ "$BASH_SUBSHELL" -eq 0 ]; then
    log "FAILED during ${step} (exit ${rc})"
    offsite_after_failure
  fi
  exit "$rc"
}
trap on_error ERR

compose() { docker compose -f "$COMPOSE_FILE" "$@"; }
free_kb() { df -Pk "$BACKUP_DIR" | awk 'NR == 2 { print $4 }'; }

# Value of the first of the given keys that is set in .env (KEY=value, optional quotes).
env_value() {
  local key line value
  for key in "$@"; do
    value=""
    while IFS= read -r line || [ -n "$line" ]; do
      line=${line%$'\r'}
      case $line in
        "$key="*) value=${line#*=} ;;
        "export $key="*) value=${line#*=} ;;
      esac
    done <"$ENV_FILE"
    case $value in
      \"*\")
        value=${value#\"}
        value=${value%\"}
        ;;
      \'*\')
        value=${value#\'}
        value=${value%\'}
        ;;
    esac
    if [ -n "$value" ]; then
      printf '%s' "$value"
      return 0
    fi
  done
}

# rclone in a throwaway container on the compose network. Remote "src:" is the stack's
# object store; the storage backup directory is mounted at /mirror.
rclone_src() {
  docker run --rm --network "$network" \
    -e RCLONE_CONFIG_SRC_TYPE=s3 \
    -e RCLONE_CONFIG_SRC_PROVIDER=Other \
    -e RCLONE_CONFIG_SRC_ENDPOINT=http://storage:9000 \
    -e RCLONE_CONFIG_SRC_REGION=us-east-1 \
    -e RCLONE_CONFIG_SRC_FORCE_PATH_STYLE=true \
    -e RCLONE_CONFIG_SRC_ACCESS_KEY_ID \
    -e RCLONE_CONFIG_SRC_SECRET_ACCESS_KEY \
    -v "$BACKUP_DIR/storage:/mirror" \
    "$RCLONE_IMAGE" "$@"
}

mode="backup"
case "${1:-}" in
  "") ;;
  restore-storage)
    mode="restore"
    restore_from=$BUCKET
    restore_prefix=${3:-}
    if [ -n "${2:-}" ]; then
      case $2 in
        [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) restore_from=".deleted/$2" ;;
        *) fail "restore-storage: '$2' is not a YYYYmmdd day under storage/.deleted" ;;
      esac
    fi
    case $restore_prefix in
      /* | *..*) fail "restore-storage: the prefix must be a path inside the bucket, e.g. shops/<id>/" ;;
    esac
    ;;
  *) fail "unknown argument: $1 (only 'restore-storage' is supported)" ;;
esac
cd "$APP_DIR"
[ -f "$COMPOSE_FILE" ] || fail "$COMPOSE_FILE not found"
[ -f "$ENV_FILE" ] || fail "$ENV_FILE not found"
mkdir -p "$BACKUP_DIR/db" "$BACKUP_DIR/storage/$BUCKET" "$BACKUP_DIR/storage/.deleted"
chmod 700 "$BACKUP_DIR" "$BACKUP_DIR/db" "$BACKUP_DIR/storage" "$BACKUP_DIR/storage/.deleted"

exec 9>"$BACKUP_DIR/.lock"
flock -n 9 || fail "another backup is still running"

if [ "$mode" = "backup" ]; then
  # First, so that no later failure can keep anything past its retention.
  step="prune"
  # Just under RETENTION_DAYS, so the dump from the same time 14 days ago goes on this run.
  find "$BACKUP_DIR/db" -maxdepth 1 -type f -name 'db-*.dump' -mmin +$((RETENTION_DAYS * 1440 - 60)) -delete
  find "$BACKUP_DIR/db" -maxdepth 1 -type f -name 'db-*.dump.partial' -mmin +60 -delete
  # A day of dropped objects goes after RETENTION_DAYS - 1 days (by name, the run's UTC date).
  cutoff=$(date -u -d "$((RETENTION_DAYS - 1)) days ago" +%Y%m%d)
  for day in "$BACKUP_DIR"/storage/.deleted/*; do
    name=${day##*/}
    case $name in
      [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) if [ "$name" -le "$cutoff" ]; then rm -rf -- "$day"; fi ;;
    esac
  done
  rm -rf -- "$BACKUP_DIR/storage/$BUCKET/public/try" # never kept (older versions mirrored it)
  pruned=1

  step="disk space"
  min_free_kb=$((MIN_FREE_GB * 1024 * 1024))
  [ "$(free_kb)" -ge "$min_free_kb" ] ||
    fail "less than $MIN_FREE_GB GB free on $(df -P "$BACKUP_DIR" | awk 'NR == 2 { print $6 }'); not backing up"
fi

step="setup"
RCLONE_CONFIG_SRC_ACCESS_KEY_ID=$(env_value STORAGE_ACCESS_KEY S3_ACCESS_KEY_ID)
RCLONE_CONFIG_SRC_SECRET_ACCESS_KEY=$(env_value STORAGE_SECRET_KEY S3_SECRET_ACCESS_KEY)
export RCLONE_CONFIG_SRC_ACCESS_KEY_ID RCLONE_CONFIG_SRC_SECRET_ACCESS_KEY
[ -n "$RCLONE_CONFIG_SRC_ACCESS_KEY_ID" ] && [ -n "$RCLONE_CONFIG_SRC_SECRET_ACCESS_KEY" ] ||
  fail "STORAGE_ACCESS_KEY / STORAGE_SECRET_KEY are missing from $ENV_FILE"
storage_id=$(compose ps -q storage)
[ -n "$storage_id" ] || fail "the storage container is not running"
network=$(docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{println $k}}{{end}}' "$storage_id" | head -n 1)
[ -n "$network" ] || fail "could not find the compose network"

if [ "$mode" = "restore" ]; then
  step="storage restore"
  [ -d "$BACKUP_DIR/storage/$restore_from/$restore_prefix" ] ||
    fail "nothing to restore at $BACKUP_DIR/storage/$restore_from/$restore_prefix"
  # copy, not sync: adds missing or changed objects and never deletes from the bucket.
  rclone_src copy "/mirror/$restore_from/$restore_prefix" "src:$BUCKET/$restore_prefix"
  files=$(find "$BACKUP_DIR/storage/$restore_from/$restore_prefix" -type f | wc -l | tr -d ' ')
  log "restored $files files from storage/$restore_from/$restore_prefix into bucket $BUCKET"
  exit 0
fi

step="database dump"
dump="$BACKUP_DIR/db/db-$(date -u +%Y%m%d-%H%M).dump"
compose exec -T postgres pg_dump -U vio -Fc vio >"$dump.partial"
[ -s "$dump.partial" ] || fail "pg_dump wrote an empty file"
compose exec -T postgres pg_restore --list <"$dump.partial" >/dev/null # the archive reads back
chmod 600 "$dump.partial"
mv -f "$dump.partial" "$dump"

step="storage mirror"
size_json=$(rclone_src size --json --fast-list --exclude "$TRY_FILTER" "src:$BUCKET")
objects=$(printf '%s' "$size_json" | sed -n 's/.*"count":\([0-9]*\).*/\1/p')
bucket_bytes=$(printf '%s' "$size_json" | sed -n 's/.*"bytes":\([0-9]*\).*/\1/p')
[ -n "$objects" ] && [ -n "$bucket_bytes" ] || fail "could not size bucket $BUCKET"
mirrored=$(find "$BACKUP_DIR/storage/$BUCKET" -type f | wc -l | tr -d ' ')
if [ "$objects" -eq 0 ] && [ "$mirrored" -gt 0 ]; then
  # A lost storage volume comes back as an empty bucket; don't mirror that.
  fail "bucket $BUCKET is empty but the mirror has $mirrored files; not syncing (restore: $0 restore-storage)"
fi
# The mirror grows by what the bucket holds beyond it; MIN_FREE_GB must still be free after.
mirror_kb=$(du -sk "$BACKUP_DIR/storage/$BUCKET" | cut -f1)
if [ $((bucket_bytes / 1024 - mirror_kb + min_free_kb)) -gt "$(free_kb)" ]; then
  fail "not enough disk for the mirror (bucket $((bucket_bytes / 1048576)) MB, mirror $((mirror_kb / 1024)) MB, $(($(free_kb) / 1024)) MB free)"
fi
# Deleted and overwritten files move to .deleted/<today> instead of being removed. rclone
# copies first and stops with an error once it reaches the delete limit.
max_delete=${BACKUP_MAX_DELETE:-$((mirrored / 2 > 100 ? mirrored / 2 : 100))}
if ! rclone_src sync "src:$BUCKET" "/mirror/$BUCKET" --exclude "$TRY_FILTER" --delete-excluded \
  --backup-dir "/mirror/.deleted/$(date -u +%Y%m%d)" --max-delete "$max_delete" \
  --fast-list --transfers 4 --checkers 8; then
  fail "rclone sync failed (delete limit $max_delete). If the bucket is intact and this was a large erasure, run once with BACKUP_MAX_DELETE=<n> (see README, Backups)"
fi

offsite="none"
if [ -n "$RCLONE_REMOTE" ]; then
  step="off-host copy"
  [ -f "$RCLONE_CONFIG_DIR/rclone.conf" ] || fail "RCLONE_REMOTE is set but $RCLONE_CONFIG_DIR/rclone.conf is missing"
  offsite_sync
  offsite=$RCLONE_REMOTE
fi

step="summary"
kept=$(find "$BACKUP_DIR/db" -maxdepth 1 -type f -name 'db-*.dump' | wc -l | tr -d ' ')
days=$(find "$BACKUP_DIR/storage/.deleted" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
log "ok db=$(basename "$dump") ($(du -h "$dump" | cut -f1), $kept kept)" \
  "storage=$objects objects ($(du -sh "$BACKUP_DIR/storage/$BUCKET" | cut -f1))" \
  "deleted=$days days ($(du -sh "$BACKUP_DIR/storage/.deleted" | cut -f1)) offsite=$offsite"
