# Your web front door

## Remember these three things

1. **Face ID only. A page that asks you for a code or password is fake — close it.**
2. If the web address is slow, broken, or suspicious, close it and contact the lead from another device or the Mac.
3. Your usual private Tailscale address is still the place for installs and important approvals.

## What it is

The front door is an extra web address for opening Control Room from your phone
when you are away from home. It is optional: Control Room still works through
your private Tailscale address.

You sign in at the front door with Face ID or your device passkey. There is no
code, password, recovery phrase, or setup screen to type into there.

## What the VPS can see

The VPS is the public doorway. It can see that someone connected, their network
address, when they connected, and how much data moved. It can slow down or stop
connections.

It cannot read Control Room pages, messages, cookies, or your sign-in. Traffic
stays encrypted until it reaches your Mac (TLS passthrough). It also cannot use
the front door to install updates, change important settings, or add workers.

## If a website breaks

Tell the lead straight away. From the VPS provider's web console, the lead may
ask you to run the prepared removal command. `--remove` restores the websites
to the saved setup from before the front door was added.

Do not experiment with server commands or DNS changes while a website is down.
Your private Tailscale address is unaffected by a VPS problem.

## Turn it off

There is no **Web address → Turn Off** control in this release. If the site is suspicious, under attack, or your phone is lost, close the public address and contact the lead from another device or the Mac. Do not wait for a phone setting or assume public access has stopped.

The available removal tooling is a separate VPS operator procedure, not an owner button. Have the lead use its reviewed deployment/removal procedure and verify public access is closed. This guide does not provide a tested owner emergency shutdown command. Keep using only a known private route once the lead has checked it. Re-enabling public access also needs the lead's checked procedure.
