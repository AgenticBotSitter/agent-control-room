#!/usr/bin/env bash
# Generic Ubuntu/Debian front-door installer. TLS on :443 is never terminated
# here: HAProxy reads ClientHello SNI and forwards the original byte stream.
set -euo pipefail
umask 077

root=/
variant=
front_host=
tailnet_target=
front_port=
site_http_port=8080
site_https_port=8443
dry_run=
remove=
render=
disable_old_serve=
website_hosts=()
allowed_sources=()

usage() {
  cat <<'EOF'
Usage:
  vps-setup.sh --variant nginx|apache|caddy|nothing --host HOST \
    --tailnet-target IP --port PORT [--website-host HOST ...] \
    [--site-http-port PORT] [--site-https-port PORT] \
    [--allow-source CIDR ...] [--disable-old-serve] [--dry-run]
  vps-setup.sh --remove [--dry-run]
  vps-setup.sh --render-haproxy --host HOST --tailnet-target IP --port PORT \
    [--site-http-port PORT] [--site-https-port PORT] [--allow-source CIDR ...]

--disable-old-serve is deliberately explicit. Without it, Serve is untouched.
--test-root is for isolated tests only and requires FRONT_DOOR_ALLOW_TEST_ROOT=1.
EOF
}

refuse() {
  printf 'front-door error: %s\n' "$1" >&2
  exit 1
}

need_value() {
  [ "$#" -ge 2 ] && [ -n "$2" ] || refuse "missing value for $1"
}

while [ "$#" -gt 0 ]; do
  case $1 in
    --variant) need_value "$@"; variant=$2; shift 2 ;;
    --host) need_value "$@"; front_host=$2; shift 2 ;;
    --tailnet-target) need_value "$@"; tailnet_target=$2; shift 2 ;;
    --port) need_value "$@"; front_port=$2; shift 2 ;;
    --site-http-port) need_value "$@"; site_http_port=$2; shift 2 ;;
    --site-https-port) need_value "$@"; site_https_port=$2; shift 2 ;;
    --website-host) need_value "$@"; website_hosts+=("$2"); shift 2 ;;
    --allow-source) need_value "$@"; allowed_sources+=("$2"); shift 2 ;;
    --disable-old-serve) disable_old_serve=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    --remove) remove=1; shift ;;
    --render-haproxy) render=1; shift ;;
    --test-root)
      need_value "$@"
      [ "${FRONT_DOOR_ALLOW_TEST_ROOT:-}" = 1 ] || refuse "--test-root is test-only"
      [[ $2 == /* ]] || refuse "--test-root must be absolute"
      root=${2%/}; [ -n "$root" ] || root=/
      shift 2
      ;;
    --help|-h) usage; exit 0 ;;
    *) refuse "unknown argument: $1" ;;
  esac
done

if [ "$root" != / ]; then
  [ -d "$root" ] || refuse "--test-root must name an existing directory"
  root=$(cd -P "$root" && pwd -P) || refuse "--test-root could not be resolved"
fi

valid_host() {
  local value=$1 label
  [ ${#value} -le 253 ] || return 1
  [[ $value =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || return 1
  [[ $value == *.* ]] || return 1
  IFS=. read -r -a labels <<<"$value"
  for label in "${labels[@]}"; do
    [ -n "$label" ] && [ ${#label} -le 63 ] || return 1
    [[ $label =~ ^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$ ]] || return 1
  done
}

valid_port() {
  [[ $1 =~ ^[0-9]+$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]
}

valid_ipv4() {
  local value=$1 octet
  [[ $value =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || return 1
  IFS=. read -r -a octets <<<"$value"
  for octet in "${octets[@]}"; do
    [ "$octet" -le 255 ] || return 1
  done
}

valid_ipv6() {
  [[ $1 == *:* ]] && [[ $1 =~ ^[0-9A-Fa-f:]+$ ]] && [[ $1 != *:::* ]]
}

valid_target() {
  local first second lower
  if valid_ipv4 "$1"; then
    IFS=. read -r first second _ <<<"$1"
    [ "$first" -eq 100 ] && [ "$second" -ge 64 ] && [ "$second" -le 127 ]
    return
  fi
  lower=$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')
  valid_ipv6 "$1" && [[ $lower == fd7a:115c:a1e0:* ]]
}

valid_cidr() {
  local address=${1%/*} prefix=${1##*/}
  [ "$address" != "$1" ] && [[ $prefix =~ ^[0-9]+$ ]] || return 1
  if valid_ipv4 "$address"; then [ "$prefix" -le 32 ];
  elif valid_ipv6 "$address"; then [ "$prefix" -le 128 ];
  else return 1
  fi
}

validate_render_inputs() {
  valid_host "$front_host" || refuse "--host must be a plain DNS hostname"
  valid_target "$tailnet_target" || refuse "--tailnet-target must be an IP literal"
  valid_port "$front_port" || refuse "--port must be from 1 to 65535"
  valid_port "$site_http_port" || refuse "--site-http-port must be from 1 to 65535"
  valid_port "$site_https_port" || refuse "--site-https-port must be from 1 to 65535"
  [ "$front_port" != "$site_http_port" ] && [ "$front_port" != "$site_https_port" ] \
    && [ "$site_http_port" != "$site_https_port" ] || refuse "ports must be distinct"
  local source
  for source in "${allowed_sources[@]+${allowed_sources[@]}}"; do
    valid_cidr "$source" || refuse "--allow-source must be an IPv4 or IPv6 CIDR"
  done
}

render_haproxy() {
  local backend_target=$tailnet_target source
  [[ $backend_target == *:* ]] && backend_target="[$backend_target]"
  cat <<EOF
global
  log /dev/log local0
  chroot /var/lib/haproxy
  user haproxy
  group haproxy
  daemon
  maxconn 400

defaults
  log global
  mode tcp
  option dontlognull
  timeout connect 5s
  timeout client 1m
  timeout server 1m

frontend public_http
  bind :80
  mode http
  acl control_room_http hdr(host) -i ${front_host} ${front_host}:80
  http-request redirect scheme https code 308 if control_room_http
  default_backend owner_websites_http

frontend public_tls
  bind :443
  mode tcp
  maxconn 400
  tcp-request inspect-delay 5s
  acl control_room_sni req.ssl_sni -i ${front_host}
  stick-table type ip size 200k expire 2m store conn_cur,conn_rate(1m)
  tcp-request content track-sc0 src if control_room_sni
  tcp-request content reject if control_room_sni { sc0_conn_cur gt 20 }
  tcp-request content reject if control_room_sni { sc0_conn_rate gt 60 }
EOF
  if [ "${#allowed_sources[@]}" -gt 0 ]; then
    printf '  acl control_room_source_allowed src'
    for source in "${allowed_sources[@]+${allowed_sources[@]}}"; do printf ' %s' "$source"; done
    printf '\n  tcp-request content reject if control_room_sni !control_room_source_allowed\n'
  fi
  cat <<EOF
  use_backend control_room_front if control_room_sni
  default_backend owner_websites_tls

backend control_room_front
  mode tcp
  server control_room_mac ${backend_target}:${front_port} send-proxy-v2

backend owner_websites_tls
  mode tcp
  server owner_web_tls 127.0.0.1:${site_https_port}

backend owner_websites_http
  mode http
  server owner_web_http 127.0.0.1:${site_http_port}
EOF
}

if [ -n "$render" ]; then
  [ -z "$remove" ] || refuse "--render-haproxy and --remove are mutually exclusive"
  validate_render_inputs
  render_haproxy
  exit 0
fi

state_root="$root/var/lib/control-room-front-door"
state_dir="$state_root/state"
lock_file="$root/run/control-room-front-door.lock"
haproxy_config="$root/etc/haproxy/haproxy.cfg"

resolved_file_within_root() {
  local path=$1 description=$2 resolved
  resolved=$(readlink -f "$path") || refuse "could not resolve $description"
  { [ "$root" = / ] || [[ $resolved == "$root"/* ]]; } \
    || refuse "$description escapes the selected root"
  printf '%s\n' "$resolved"
}

check_haproxy_config_path() {
  [ -e "$haproxy_config" ] || return 0
  resolved_file_within_root "$haproxy_config" "HAProxy configuration" >/dev/null
}

check_fixed_variant_paths() {
  local ports caddy
  case $variant in
    apache)
      ports="$root/etc/apache2/ports.conf"
      [ -f "$ports" ] || return 0
      resolved_file_within_root "$ports" "Apache ports.conf" >/dev/null
      ;;
    caddy)
      caddy="$root/etc/caddy/Caddyfile"
      [ -f "$caddy" ] || return 0
      resolved_file_within_root "$caddy" "Caddyfile" >/dev/null
      ;;
  esac
}

if [ -n "$remove" ]; then
  [ -z "$variant$front_host$tailnet_target$front_port$disable_old_serve" ] \
    && [ "${#website_hosts[@]}" -eq 0 ] && [ "${#allowed_sources[@]}" -eq 0 ] \
    || refuse "--remove does not accept install arguments"
else
  case $variant in nginx|apache|caddy|nothing) ;; *) refuse "--variant must be nginx, apache, caddy, or nothing" ;; esac
  validate_render_inputs
  if [ "$variant" != nothing ] && [ "${#website_hosts[@]}" -eq 0 ]; then
    refuse "at least one --website-host is required for this variant"
  fi
  local_host=
  for local_host in "${website_hosts[@]+${website_hosts[@]}}"; do
    valid_host "$local_host" || refuse "--website-host must be a plain DNS hostname"
    [ "$(printf '%s' "$local_host" | tr '[:upper:]' '[:lower:]')" != \
      "$(printf '%s' "$front_host" | tr '[:upper:]' '[:lower:]')" ] \
      || refuse "the Control Room host cannot be a website health host"
  done
fi

if [ "$root" = / ] && [ "$(id -u)" -ne 0 ]; then
  refuse "run as root on the VPS"
fi
if [ "$root" = / ] && ! grep -Eq '^ID=(ubuntu|debian)$|^ID_LIKE=.*(ubuntu|debian)' /etc/os-release 2>/dev/null; then
  refuse "only Ubuntu and Debian are supported"
fi

quote_command() {
  local value first=1
  for value in "$@"; do
    [ $first -eq 1 ] || printf ' '
    printf '%q' "$value"
    first=0
  done
  printf '\n'
}

run_change() {
  if [ -n "$dry_run" ]; then
    printf 'would run: '
    quote_command "$@"
  else
    "$@"
  fi
}

if [ -n "$dry_run" ]; then
  check_haproxy_config_path
  if [ -n "$remove" ]; then
    [ -d "$state_dir" ] || refuse "front door is not installed"
    variant=$(awk -F= '$1 == "variant" { print $2; exit }' "$state_dir/meta")
    check_fixed_variant_paths
    printf 'would restore the saved website, HAProxy, Tailscale, and service state\n'
    printf 'would verify every saved website before and after removal\n'
  else
    if [ -d "$state_dir" ]; then
      printf 'would verify the existing installation and make no changes if it matches\n'
    else
      printf 'would install HAProxy if absent\n'
      printf 'would back up every file before changing it under %s\n' "$state_root"
      printf 'would move %s website listeners to 127.0.0.1:%s and 127.0.0.1:%s\n' \
        "$variant" "$site_http_port" "$site_https_port"
      printf 'would write and validate %s\n' "$haproxy_config"
      printf 'would set restrictive Tailscale preferences\n'
      if [ -n "$disable_old_serve" ]; then printf 'would save and reset the existing Tailscale Serve configuration\n';
      else printf 'would leave Tailscale Serve unchanged\n'; fi
      printf 'would restart the website service, enable HAProxy, and verify every website\n'
    fi
  fi
  exit 0
fi

if [ -z "$remove" ]; then
  check_haproxy_config_path
  check_fixed_variant_paths
fi

mkdir -p "${lock_file%/*}"
exec 9>>"$lock_file"
perl -MFcntl=:flock -e 'open(my $fh, ">&=", 9) or exit 2; flock($fh, LOCK_EX | LOCK_NB) or exit 1' \
  || refuse "another front-door operation is running"

transaction=
transaction_kind=
work_dir=
web_service=

read_meta() {
  local wanted=$1 key value
  while IFS='=' read -r key value; do
    [ "$key" = "$wanted" ] && { printf '%s' "$value"; return 0; }
  done <"$state_dir/meta"
  return 1
}

service_enabled_state() {
  local service=$1 state
  state=$(systemctl is-enabled "$service" 2>/dev/null || true)
  [ -n "$state" ] && printf '%s' "$state" || printf disabled
}

service_active_state() {
  local service=$1 state
  state=$(systemctl is-active "$service" 2>/dev/null || true)
  [ -n "$state" ] && printf '%s' "$state" || printf inactive
}

set_service_state() {
  local service=$1 enabled=$2 active=$3
  systemctl unmask "$service" >/dev/null 2>&1 || true
  case $active in
    active|yes) systemctl restart "$service" >/dev/null 2>&1 || true ;;
    *) systemctl stop "$service" >/dev/null 2>&1 || true ;;
  esac
  case $enabled in
    enabled|enabled-runtime|yes) systemctl enable "$service" >/dev/null 2>&1 || true ;;
    disabled|no) systemctl disable "$service" >/dev/null 2>&1 || true ;;
    masked|masked-runtime) systemctl mask "$service" >/dev/null 2>&1 || true ;;
    static|indirect|generated|transient|alias) ;;
    *) printf 'front-door warning: unknown saved enable state for %s: %s\n' "$service" "$enabled" >&2 ;;
  esac
}

restore_files_from() {
  local snapshot=$1 relative destination
  [ -f "$snapshot/files.list" ] || return 0
  while IFS= read -r relative; do
    [ -n "$relative" ] || continue
    destination="$root$relative"
    mkdir -p "${destination%/*}"
    cp -p "$snapshot/files$relative" "$destination"
  done <"$snapshot/files.list"
  if [ -f "$snapshot/haproxy.absent" ]; then rm -f "$haproxy_config"; fi
}

restore_tailscale_from_state() {
  local source=$1 argument
  if [ -s "$source/tailscale-restore.args" ]; then
    restore_args=()
    while IFS= read -r argument; do restore_args+=("$argument"); done <"$source/tailscale-restore.args"
    tailscale set "${restore_args[@]}" >/dev/null
  fi
  if [ -f "$source/serve.changed" ]; then
    tailscale serve set-raw <"$source/serve.json" >/dev/null
  fi
}

secure_tailscale() {
  tailscale set --shields-up=true --accept-routes=false --accept-dns=false --ssh=false \
    --advertise-exit-node=false --advertise-routes= >/dev/null
  if [ -n "$disable_old_serve" ]; then tailscale serve reset >/dev/null; fi
}

rollback_install() {
  [ -n "$work_dir" ] && [ -d "$work_dir" ] || return 0
  set +e
  systemctl stop haproxy >/dev/null 2>&1
  restore_files_from "$work_dir"
  if [ -n "$web_service" ]; then set_service_state "$web_service" \
    "$(cat "$work_dir/web.enabled")" "$(cat "$work_dir/web.active")"; fi
  set_service_state haproxy "$(cat "$work_dir/haproxy.enabled")" "$(cat "$work_dir/haproxy.active")"
  restore_tailscale_from_state "$work_dir" >/dev/null 2>&1
  if [ -f "$work_dir/package.absent" ]; then apt-get purge -y haproxy >/dev/null 2>&1; fi
  rm -rf "$work_dir"
  set -e
}

rollback_remove() {
  [ -n "$work_dir" ] && [ -d "$work_dir" ] || return 0
  set +e
  if [ "$(read_meta package_preexisting 2>/dev/null)" = no ]; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends haproxy >/dev/null 2>&1
  fi
  restore_files_from "$work_dir"
  if [ -n "$web_service" ]; then systemctl restart "$web_service" >/dev/null 2>&1; fi
  systemctl unmask haproxy >/dev/null 2>&1
  systemctl enable haproxy >/dev/null 2>&1
  systemctl restart haproxy >/dev/null 2>&1
  tailscale set --shields-up=true --accept-routes=false --accept-dns=false --ssh=false \
    --advertise-exit-node=false --advertise-routes= >/dev/null 2>&1
  if [ -f "$state_dir/serve.changed" ]; then tailscale serve reset >/dev/null 2>&1; fi
  rm -rf "$work_dir"
  set -e
}

on_exit() {
  local status=$?
  trap - EXIT HUP INT TERM
  if [ -n "$transaction" ]; then
    printf 'front-door error: operation failed; restoring the previous state\n' >&2
    if [ "$transaction_kind" = install ]; then rollback_install; else rollback_remove; fi
  fi
  exit "$status"
}
trap on_exit EXIT
trap 'exit 130' HUP INT TERM

snapshot_file() {
  local snapshot=$1 path=$2 relative destination
  [ -f "$path" ] || return 0
  relative=${path#"$root"}
  grep -Fqx -- "$relative" "$snapshot/files.list" 2>/dev/null && return 0
  destination="$snapshot/files$relative"
  mkdir -p "${destination%/*}"
  cp -p "$path" "$destination"
  printf '%s\n' "$relative" >>"$snapshot/files.list"
}

collect_variant_files() {
  local entry resolved
  variant_files=()
  case $variant in
    nginx)
      for entry in "$root/etc/nginx/sites-enabled" "$root/etc/nginx/conf.d"; do
        [ -d "$entry" ] || continue
        while IFS= read -r -d '' resolved; do
          resolved=$(readlink -f "$resolved") || refuse "could not resolve nginx configuration"
          { [ "$root" = / ] || [[ $resolved == "$root"/* ]]; } \
            || refuse "website configuration escapes the selected root"
          variant_files+=("$resolved")
        done < <(find -L "$entry" -type f \( -name '*.conf' -o -path "$root/etc/nginx/sites-enabled/*" \) -print0)
      done
      web_service=nginx
      ;;
    apache)
      if [ -f "$root/etc/apache2/ports.conf" ]; then
        resolved=$(resolved_file_within_root "$root/etc/apache2/ports.conf" "Apache ports.conf")
        variant_files+=("$resolved")
      fi
      if [ -d "$root/etc/apache2/sites-enabled" ]; then
        while IFS= read -r -d '' resolved; do
          resolved=$(readlink -f "$resolved") || refuse "could not resolve Apache configuration"
          { [ "$root" = / ] || [[ $resolved == "$root"/* ]]; } \
            || refuse "website configuration escapes the selected root"
          variant_files+=("$resolved")
        done < <(find -L "$root/etc/apache2/sites-enabled" -type f -name '*.conf' -print0)
      fi
      web_service=apache2
      ;;
    caddy)
      resolved=$(resolved_file_within_root "$root/etc/caddy/Caddyfile" "Caddyfile")
      variant_files=("$resolved")
      web_service=caddy
      ;;
    nothing) variant_files=(); web_service= ;;
  esac
  if [ "$variant" != nothing ] && [ "${#variant_files[@]}" -eq 0 ]; then
    refuse "no $variant website configuration was found"
  fi
}

save_tailscale_state() {
  local snapshot=$1
  tailscale debug prefs >"$snapshot/tailscale-prefs.json"
  python3 - "$snapshot/tailscale-prefs.json" >"$snapshot/tailscale-restore.args" <<'PY'
import json, sys
p = json.load(open(sys.argv[1], encoding="utf-8"))
for key in ("ShieldsUp", "RouteAll", "CorpDNS", "RunSSH"):
    if key not in p or not isinstance(p[key], bool):
        raise SystemExit(f"tailscale prefs missing boolean {key}")
if p.get("AdvertiseRoutes") is not None and (
    not isinstance(p["AdvertiseRoutes"], list) or
    not all(isinstance(route, str) for route in p["AdvertiseRoutes"])
):
    raise SystemExit("tailscale prefs has invalid AdvertiseRoutes")
def flag(name, value): print(f"--{name}={'true' if value else 'false'}")
flag("shields-up", bool(p.get("ShieldsUp", False)))
flag("accept-routes", bool(p.get("RouteAll", False)))
flag("accept-dns", bool(p.get("CorpDNS", False)))
flag("ssh", bool(p.get("RunSSH", False)))
routes = list(p.get("AdvertiseRoutes") or [])
exit_routes = {"0.0.0.0/0", "::/0"}
flag("advertise-exit-node", bool(exit_routes.intersection(routes)))
print("--advertise-routes=" + ",".join(r for r in routes if r not in exit_routes))
PY
  if [ -n "$disable_old_serve" ]; then
    tailscale serve status --json >"$snapshot/serve.json"
    python3 - "$snapshot/serve.json" <<'PY'
import json, sys
json.load(open(sys.argv[1], encoding="utf-8"))
PY
    : >"$snapshot/serve.changed"
  fi
}

health_check() {
  local port=$1 host
  for host in "${website_hosts[@]+${website_hosts[@]}}"; do
    curl --fail --silent --show-error --connect-timeout 5 --max-time 15 \
      --connect-to "$host:443:127.0.0.1:$port" "https://$host/" >/dev/null
  done
}

validate_website() {
  case $variant in
    nginx) nginx -t ;;
    apache) apache2ctl configtest ;;
    caddy) caddy validate --config "$root/etc/caddy/Caddyfile" ;;
    nothing) return 0 ;;
  esac
}

rewrite_nginx() {
  local has_v4_http='' has_v4_https='' file
  for file in "${variant_files[@]}"; do
    grep -Eq '^[[:space:]]*listen[[:space:]]+([0-9.]+:)?80([[:space:];]|$)' "$file" && has_v4_http=1 || true
    grep -Eq '^[[:space:]]*listen[[:space:]]+([0-9.]+:)?443([[:space:];]|$)' "$file" && has_v4_https=1 || true
  done
  for file in "${variant_files[@]}"; do
    FD_HTTP_PORT=$site_http_port FD_HTTPS_PORT=$site_https_port FD_HAS_V4_HTTP=$has_v4_http \
      FD_HAS_V4_HTTPS=$has_v4_https perl -0pi -e '
        my $hp=$ENV{FD_HTTP_PORT}; my $sp=$ENV{FD_HTTPS_PORT};
        s{^(\s*)listen\s+(?:[0-9.]+:)?80([^;]*;)}{$1."listen 127.0.0.1:$hp".$2}egm;
        s{^(\s*)listen\s+(?:[0-9.]+:)?443([^;]*;)}{$1."listen 127.0.0.1:$sp".$2}egm;
        if ($ENV{FD_HAS_V4_HTTP}) { s{^(\s*)listen\s+(\[[^]]+\]):80([^;]*;)}{$1."# front-door disabled IPv6: listen ".$2.":80".$3}egm; }
        else { s{^(\s*)listen\s+\[[^]]+\]:80([^;]*;)}{$1."listen 127.0.0.1:$hp".$2}egm; }
        if ($ENV{FD_HAS_V4_HTTPS}) { s{^(\s*)listen\s+(\[[^]]+\]):443([^;]*;)}{$1."# front-door disabled IPv6: listen ".$2.":443".$3}egm; }
        else { s{^(\s*)listen\s+\[[^]]+\]:443([^;]*;)}{$1."listen 127.0.0.1:$sp".$2}egm; }
      ' "$file"
  done
  ! grep -ER '^[[:space:]]*listen[[:space:]]+(([0-9.]+:)?(80|443)|\[[^]]+\]:(80|443))([[:space:];]|$)' \
    "${variant_files[@]}" || refuse "nginx still has a public website listener"
}

rewrite_apache() {
  local file
  for file in "${variant_files[@]}"; do
    FD_HTTP_PORT=$site_http_port FD_HTTPS_PORT=$site_https_port perl -0pi -e '
      my $hp=$ENV{FD_HTTP_PORT}; my $sp=$ENV{FD_HTTPS_PORT};
      s{^(\s*)Listen\s+(?:(?:[0-9.]+|\[[^]]+\]):)?80\s*$}{$1."Listen 127.0.0.1:$hp"}egm;
      s{^(\s*)Listen\s+(?:(?:[0-9.]+|\[[^]]+\]):)?443\s*$}{$1."Listen 127.0.0.1:$sp"}egm;
      s{<VirtualHost\s+(?:\*|_default_|[0-9.]+|\[[^]]+\]):80>}{"<VirtualHost 127.0.0.1:$hp>"}eg;
      s{<VirtualHost\s+(?:\*|_default_|[0-9.]+|\[[^]]+\]):443>}{"<VirtualHost 127.0.0.1:$sp>"}eg;
    ' "$file"
  done
  ! grep -ER '(^[[:space:]]*Listen[[:space:]]+([^[:space:]]+:)?(80|443)[[:space:]]*$|<VirtualHost[[:space:]]+[^[:space:]]+:(80|443)>)' \
    "${variant_files[@]}" || refuse "Apache still has a public website listener"
}

rewrite_caddy() {
  local file=${variant_files[0]} temporary first_directive
  [ -f "$file" ] || refuse "Caddyfile was not found"
  ! grep -Eq '^[[:space:]]*(http_port|https_port|default_bind)[[:space:]]' "$file" \
    || refuse "Caddyfile already overrides listener ports or default_bind"
  temporary="$file.front-door.$$"
  first_directive=$(awk '!/^[[:space:]]*($|#)/ { print; exit }' "$file")
  if printf '%s\n' "$first_directive" | grep -Eq '^[[:space:]]*\{[[:space:]]*$'; then
    awk -v hp="$site_http_port" -v sp="$site_https_port" '
      !inserted && /^[[:space:]]*\{[[:space:]]*$/ { print; print "\thttp_port " hp "\n\thttps_port " sp "\n\tdefault_bind 127.0.0.1"; inserted=1; next }
      { print }
    ' \
      "$file" >"$temporary"
  else
    { printf '{\n\thttp_port %s\n\thttps_port %s\n\tdefault_bind 127.0.0.1\n}\n\n' \
        "$site_http_port" "$site_https_port"; cat "$file"; } >"$temporary"
  fi
  chmod --reference="$file" "$temporary" 2>/dev/null || chmod 600 "$temporary"
  mv "$temporary" "$file"
}

rewrite_variant() {
  case $variant in nginx) rewrite_nginx ;; apache) rewrite_apache ;; caddy) rewrite_caddy ;; nothing) ;; esac
}

same_install() {
  [ -d "$state_dir" ] || return 1
  [ "$(read_meta variant)" = "$variant" ] \
    && [ "$(read_meta host)" = "$front_host" ] \
    && [ "$(read_meta target)" = "$tailnet_target" ] \
    && [ "$(read_meta port)" = "$front_port" ] \
    && [ "$(read_meta site_http_port)" = "$site_http_port" ] \
    && [ "$(read_meta site_https_port)" = "$site_https_port" ] \
    && [ "$(read_meta disable_old_serve)" = "${disable_old_serve:-no}" ] \
    && cmp -s <(printf '%s\n' "${website_hosts[@]+${website_hosts[@]}}") "$state_dir/website-hosts" \
    && cmp -s <(printf '%s\n' "${allowed_sources[@]+${allowed_sources[@]}}") "$state_dir/allowed-sources" \
    && cmp -s <(render_haproxy) "$haproxy_config"
}

if [ -z "$remove" ]; then
  front_host=$(printf '%s' "$front_host" | tr '[:upper:]' '[:lower:]')
  if [ -d "$state_dir" ]; then
    same_install || refuse "a different front-door installation already exists; remove it first"
    health_check 443
    printf 'front door: already configured\n'
    transaction=
    exit 0
  fi

  health_check 443
  command -v tailscale >/dev/null || refuse "tailscale is not installed"
  command -v python3 >/dev/null || refuse "python3 is required"
  command -v systemctl >/dev/null || refuse "systemctl is required"
  command -v curl >/dev/null || refuse "curl is required"
  command -v perl >/dev/null || refuse "perl is required"
  collect_variant_files
  if [ "$root" = / ]; then
    if dpkg-query -W -f='${Status}' haproxy 2>/dev/null | grep -Fq 'install ok installed'; then package_preexisting=yes;
    else package_preexisting=no; fi
  else
    package_preexisting=yes
  fi

  timestamp=$(date -u +%Y%m%dT%H%M%SZ)
  work_dir="$state_root/.install-$timestamp-$$"
  mkdir -p "$work_dir/files"
  : >"$work_dir/files.list"
  transaction=1
  transaction_kind=install
  if [ "$package_preexisting" = no ]; then : >"$work_dir/package.absent"; fi
  printf '%s' "$(service_enabled_state haproxy)" >"$work_dir/haproxy.enabled"
  printf '%s' "$(service_active_state haproxy)" >"$work_dir/haproxy.active"
  if [ -n "$web_service" ]; then
    printf '%s' "$(service_enabled_state "$web_service")" >"$work_dir/web.enabled"
    printf '%s' "$(service_active_state "$web_service")" >"$work_dir/web.active"
    case $(cat "$work_dir/web.active") in active|yes) ;; *) refuse "$web_service is not active" ;; esac
  else
    printf no >"$work_dir/web.enabled"; printf no >"$work_dir/web.active"
  fi
  [ -f "$haproxy_config" ] && snapshot_file "$work_dir" "$haproxy_config" || : >"$work_dir/haproxy.absent"
  file=
  for file in "${variant_files[@]+${variant_files[@]}}"; do snapshot_file "$work_dir" "$file"; done
  save_tailscale_state "$work_dir"
  printf '%s\n' "$timestamp" >"$work_dir/backup.timestamp"

  if [ "$package_preexisting" = no ]; then
    apt-get update
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends haproxy
  fi
  command -v haproxy >/dev/null || refuse "haproxy is not installed"

  mkdir -p "${haproxy_config%/*}"
  rewrite_variant
  validate_website
  if [ -n "${FRONT_DOOR_TEST_STOP_AFTER_WEBSITE:-}" ]; then kill -TERM $$; fi
  if [ -n "$web_service" ]; then systemctl restart "$web_service"; health_check "$site_https_port"; fi
  render_haproxy >"$haproxy_config"
  chmod 600 "$haproxy_config"
  haproxy -c -f "$haproxy_config"
  systemctl unmask haproxy
  systemctl enable haproxy
  systemctl restart haproxy
  health_check 443
  secure_tailscale

  {
    printf 'variant=%s\n' "$variant"
    printf 'host=%s\n' "$front_host"
    printf 'target=%s\n' "$tailnet_target"
    printf 'port=%s\n' "$front_port"
    printf 'site_http_port=%s\n' "$site_http_port"
    printf 'site_https_port=%s\n' "$site_https_port"
    printf 'web_service=%s\n' "$web_service"
    printf 'disable_old_serve=%s\n' "${disable_old_serve:-no}"
    printf 'package_preexisting=%s\n' "$package_preexisting"
    printf 'installed_at=%s\n' "$timestamp"
  } >"$work_dir/meta"
  printf '%s\n' "${website_hosts[@]+${website_hosts[@]}}" >"$work_dir/website-hosts"
  printf '%s\n' "${allowed_sources[@]+${allowed_sources[@]}}" >"$work_dir/allowed-sources"
  mv "$work_dir" "$state_dir"
  work_dir=
  transaction=
  printf 'front door: ready\n'
  exit 0
fi

# Removal is also transactional: retain the installed files until the restored
# websites have answered through their original public listener.
[ -d "$state_dir" ] || refuse "front door is not installed"
variant=$(read_meta variant)
front_host=$(read_meta host)
tailnet_target=$(read_meta target)
front_port=$(read_meta port)
site_http_port=$(read_meta site_http_port)
site_https_port=$(read_meta site_https_port)
web_service=$(read_meta web_service || true)
disable_old_serve=$(read_meta disable_old_serve)
website_hosts=()
while IFS= read -r entry; do [ -n "$entry" ] && website_hosts+=("$entry"); done <"$state_dir/website-hosts"
allowed_sources=()
while IFS= read -r entry; do [ -n "$entry" ] && allowed_sources+=("$entry"); done <"$state_dir/allowed-sources"
check_haproxy_config_path
check_fixed_variant_paths
collect_variant_files
health_check 443
work_dir="$state_root/.remove-$$"
mkdir -p "$work_dir/files"
: >"$work_dir/files.list"
transaction=1
transaction_kind=remove
relative=
while IFS= read -r relative; do
  [ -n "$relative" ] && snapshot_file "$work_dir" "$root$relative"
done <"$state_dir/files.list"
snapshot_file "$work_dir" "$haproxy_config"

systemctl stop haproxy
restore_files_from "$state_dir"
if [ -n "$web_service" ]; then systemctl restart "$web_service"; fi
set_service_state haproxy "$(cat "$state_dir/haproxy.enabled")" "$(cat "$state_dir/haproxy.active")"
restore_tailscale_from_state "$state_dir"
if [ "$(read_meta package_preexisting)" = no ]; then apt-get purge -y haproxy; fi
restore_files_from "$state_dir"
health_check 443
rm -rf "$state_dir" "$work_dir"
rmdir "$state_root" 2>/dev/null || true
work_dir=
transaction=
printf 'front door: removed\n'
