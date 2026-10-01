# FD-7 Linux container verification

Run this only in a disposable Ubuntu or Debian container. It must not target a
real VPS, real hostname, real address, live Tailscale node, or the Mac. The
repository test suite uses a fake root and fake commands; this procedure is the
later Linux-side check of package, parser, and service-manager behavior.

## Container contract

- Use a privileged disposable container with systemd as PID 1. Do not reuse a
  host or container that serves any website.
- Give the container no Tailscale authentication key and no route to a real
  tailnet. Install a fake `tailscale` executable before running the script.
- Use only reserved example names and addresses: `front.example.invalid`,
  `site.example.invalid`, and a synthetic address from Tailscale's CGNAT range.
- Retain the container only long enough to collect logs, then destroy it.

## Image preparation

1. Start a fresh Ubuntu 24.04 or Debian 13 systemd-capable container.
2. Install `bash`, `curl`, `haproxy`, `nginx`, `apache2`, `caddy`, `perl`, and
   `python3`. Stop and disable all four web/proxy services.
3. Copy the repository checkout into `/src` at the commit under review.
4. Put a fake `tailscale` first on `PATH`. It must implement:
   `debug prefs`, `set`, `serve status --json`, `serve reset`, and
   `serve set-raw`. It must log arguments and keep its prefs/Serve JSON in a
   temporary directory. It must never invoke a network client.
5. Point `site.example.invalid` and `front.example.invalid` to `127.0.0.1` in
   the container's hosts file. Create a throwaway self-signed website
   certificate for `site.example.invalid`; this is website fixture material,
   never a Control Room certificate.

## Run each variant

For `nginx`, `apache`, and `caddy`, configure one HTTPS website on public 443
and its normal HTTP redirect on public 80. Start that server and prove both
URLs answer locally. Then run:

```sh
PATH="/tmp/fake-bin:$PATH" /src/deploy/front-door/vps-setup.sh \
  --variant nginx \
  --host front.example.invalid \
  --tailnet-target 100.100.100.100 \
  --port 9443 \
  --website-host site.example.invalid \
  --disable-old-serve
```

Repeat with `--variant apache` and `--variant caddy` in fresh containers.
For `--variant nothing`, omit `--website-host` and begin with no website
server. Do not substitute a real hostname, IP, or Tailscale executable.

For every variant, verify all of the following:

1. `haproxy -c -f /etc/haproxy/haproxy.cfg` succeeds.
2. The TLS frontend is `mode tcp`; its Control Room backend has
   `send-proxy-v2`; no `ssl`, `crt`, key, or PEM path exists in that backend or
   frontend.
3. `openssl s_client -connect 127.0.0.1:443 -servername site.example.invalid`
   receives the fixture website certificate and the website still answers.
4. The Control Room SNI routes toward only the synthetic tailnet address. A
   temporary TCP listener may replace that unreachable target to capture bytes;
   if used, prove the bytes after the PROXY v2 header are the unchanged TLS
   ClientHello. Do not stand up TLS on HAProxy.
5. More than 20 simultaneous Control Room-SNI connections are bounded, and a
   burst above 60 new connections in one minute is refused. Website-SNI traffic
   remains available during the burst.
6. A source outside each configured `--allow-source` CIDR is refused only for
   the Control Room SNI; the same source can still reach the website SNI.
7. The website service listens only on `127.0.0.1:8080` and
   `127.0.0.1:8443`; HAProxy alone owns public 80/443.
8. The fake Tailscale log contains the restrictive `set` flags. Serve reset is
   absent without `--disable-old-serve` and present with it.
9. A second identical run prints `front door: already configured` and does not
   restart a service, change Tailscale, or rewrite a file.
10. `--remove` restores byte-identical website and HAProxy files, original
    service enabled/active states, original fake prefs, and original raw Serve
    JSON. The original website again owns public 80/443 and answers.

## Failure and interruption checks

Repeat one variant while making the post-HAProxy website probe fail. The script
must exit nonzero, print that it restored the previous state, leave the original
website answering, and leave no installed state directory. Retry without the
fault and require success.

Repeat while sending `TERM` after the website configuration is rewritten but
before HAProxy starts. Require the same rollback. Run 50 simultaneous identical
callers; exactly one may perform the install, while the others either report the
completed idempotent state or refuse the held lock. Afterward, validate the
configuration and perform the remove round trip.

Finally run the repository lane and guards inside the checkout:

```sh
pnpm test:front-door
pnpm check
pnpm run check:demo
node scripts/check-test-lane-coverage.mjs
node scripts/check-private-names.mjs
```

The private-name command needs the review environment's configured generic
deny-list. Record exact commands, exit codes, HAProxy version, distribution,
and any untested item. Destroy the container and confirm no test process or
listener remains.
