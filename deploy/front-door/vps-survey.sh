#!/bin/sh
# Read-only survey for the Control Room VPS front door.  Run from the provider
# console as root or with sudo.  It does not contact any host or change state.

set -u

have() {
  found_command="$(command -v "$1")"
  [ -n "$found_command" ]
}

append_word() {
  if [ -z "$1" ]; then
    printf '%s' "$2"
  else
    printf '%s,%s' "$1" "$2"
  fi
}

listener_addresses() {
  port="$1"
  ss -ltnH | awk -v suffix=":$port" '$4 ~ (suffix "$") { print $4 }' | sort -u | paste -sd, -
}

web_servers=""
if have nginx; then
  web_servers="$(append_word "$web_servers" nginx)"
  printf '%s\n' 'nginx is installed; its version follows:'
  nginx -v
fi
if have apache2ctl; then
  web_servers="$(append_word "$web_servers" apache)"
  printf '%s\n' 'Apache is installed; its version follows:'
  apache2ctl -v
fi
if have haproxy; then
  web_servers="$(append_word "$web_servers" haproxy)"
  printf '%s\n' 'HAProxy is installed; its version follows:'
  haproxy -v
fi
if have caddy; then
  web_servers="$(append_word "$web_servers" caddy)"
  printf '%s\n' 'Caddy is installed; its version follows:'
  caddy version
fi
[ -n "$web_servers" ] || web_servers="none found"

if have ss; then
  listeners_80="$(listener_addresses 80)"
  listeners_443="$(listener_addresses 443)"
else
  listeners_80="unavailable: ss is not installed"
  listeners_443="unavailable: ss is not installed"
fi
[ -n "$listeners_80" ] || listeners_80="none"
[ -n "$listeners_443" ] || listeners_443="none"

tailscale_present=no
tailscale_version=not-installed
tailscale_flags=unavailable
serve_state=unavailable
funnel_state=unavailable
if have tailscale; then
  tailscale_present=yes
  printf '%s\n' 'Tailscale is installed; its version follows:'
  tailscale version
  tailscale_version=reported-above
  prefs="$(tailscale debug prefs || true)"
  tailscale_flags="$(printf '%s\n' "$prefs" | grep -E '"(ShieldsUp|AcceptRoutes|AcceptDNS|RunSSH|AdvertiseExitNode)"' | tr '\n' ';')"
  [ -n "$tailscale_flags" ] || tailscale_flags="not readable by this client"
  serve_info="$(tailscale serve status --json || true)"
  if printf '%s' "$serve_info" | grep -Eq '"(TCP|Web)"[[:space:]]*:'; then
    serve_state=configured
  else
    serve_state=not-configured
  fi
  if printf '%s' "$serve_info" | grep -Eq '"AllowFunnel"[[:space:]]*:[[:space:]]*true|"Funnel"[[:space:]]*:[[:space:]]*true'; then
    funnel_state=enabled
  else
    funnel_state=not-enabled
  fi
fi

ipv6_present=no
if [ -r /proc/net/if_inet6 ] && [ -s /proc/net/if_inet6 ]; then
  ipv6_present=yes
fi
case "$listeners_80,$listeners_443" in
  *"["*|*"::"*) ipv6_present=yes ;;
esac

firewall_kind=none-detected
firewall_ports=unknown
if have ufw; then
  firewall_kind=ufw
  ufw_status="$(ufw status || true)"
  port80=closed
  port443=closed
  printf '%s\n' "$ufw_status" | grep -Eq '(^|[[:space:]])80([[:space:]]|/tcp).*ALLOW' && port80=open
  printf '%s\n' "$ufw_status" | grep -Eq '(^|[[:space:]])443([[:space:]]|/tcp).*ALLOW' && port443=open
  firewall_ports="80=$port80,443=$port443"
elif have nft; then
  firewall_kind=nftables
  nft_rules="$(nft list ruleset || true)"
  port80=not-mentioned
  port443=not-mentioned
  printf '%s\n' "$nft_rules" | grep -Eq 'dport[[:space:]]+80([^0-9]|$)|dport[[:space:]]*\{[^}]*80' && port80=mentioned
  printf '%s\n' "$nft_rules" | grep -Eq 'dport[[:space:]]+443([^0-9]|$)|dport[[:space:]]*\{[^}]*443' && port443=mentioned
  firewall_ports="80=$port80,443=$port443 (review policy manually)"
fi

disk_free_kib=unavailable
if have df; then
  disk_free_kib="$(df -k / | awk 'NR == 2 { print $4 }')"
  [ -n "$disk_free_kib" ] || disk_free_kib=unavailable
fi
ram_available_kib=unavailable
if have free; then
  ram_available_kib="$(free -k | awk '/^Mem:/ { print $7 }')"
  [ -n "$ram_available_kib" ] || ram_available_kib=unavailable
fi

case ",$web_servers," in
  *,nginx,*) variant="nginx: move existing HTTPS website listener to loopback, then put HAProxy on public 443" ;;
  *,apache,*) variant="apache: move existing HTTPS website listener to loopback, then put HAProxy on public 443" ;;
  *,caddy,*) variant="caddy: move existing HTTPS website listener to loopback, then put HAProxy on public 443" ;;
  *)
    if [ "$listeners_443" = none ]; then
      variant="no existing public HTTPS listener: install HAProxy on public 443 without moving a website server"
    else
      variant="other or unclear HTTPS server: lead review required; use a second IPv4 address if moving it to loopback is risky"
    fi
    ;;
esac

printf '\n%s\n' 'Survey summary: this did not change the VPS or contact the network.'
printf '%s\n' "Installed web servers: $web_servers"
printf '%s\n' "Port 80 listeners: $listeners_80"
printf '%s\n' "Port 443 listeners: $listeners_443"
printf '%s\n' "IPv6 present: $ipv6_present"
printf '%s\n' "Firewall: $firewall_kind; $firewall_ports"
printf '%s\n' "Free disk: $disk_free_kib KiB; available RAM: $ram_available_kib KiB"
printf '%s\n' "Recommended FD-7 variant: $variant"
printf '%s\n' 'Send only the block below to the lead. It intentionally contains no configuration or credentials.'
printf '%s\n' 'BEGIN_VPS_SURVEY'
printf '%s\n' "web_servers=$web_servers"
printf '%s\n' "listeners_80=$listeners_80"
printf '%s\n' "listeners_443=$listeners_443"
printf '%s\n' "ipv6_present=$ipv6_present"
printf '%s\n' "firewall=$firewall_kind;$firewall_ports"
printf '%s\n' "disk_free_kib=$disk_free_kib"
printf '%s\n' "ram_available_kib=$ram_available_kib"
printf '%s\n' "tailscale_present=$tailscale_present"
printf '%s\n' "tailscale_version=$tailscale_version"
printf '%s\n' "tailscale_readable_flags=$tailscale_flags"
printf '%s\n' "serve=$serve_state"
printf '%s\n' "funnel=$funnel_state"
printf '%s\n' "fd7_variant=$variant"
printf '%s\n' 'END_VPS_SURVEY'
