# Install Control Room on a Mac (one command)

For an Apple silicon Mac. You need:
- your Mac password;
- a GitHub read token;
- your phone, on the same tailnet as the Mac;
- Apple's Command Line Tools. If you don't have them, run `xcode-select --install` once; the installer checks for them first.

1. Find the release commit (40 characters) on the release page.
2. Open Terminal and paste this one line, with that commit in both places:

```bash
/bin/sh -c "$(curl -fsSL https://raw.githubusercontent.com/AgenticBotSitter/agent-control-room/<commit>/scripts/install.sh)" install <commit>
```

3. Type your Mac password. Nothing shows while you type.
4. Paste the GitHub read token. Nothing shows here either.
5. Wait while it downloads, builds and installs. This takes several minutes.
6. A QR code appears. Scan it with your phone, approve with Face ID, then type the 6-character code your phone shows.
7. The install is done when you see `Ready: Control Room release ...`.

Naming the commit in the command is your confirmation. The installer builds exactly that commit from the protected `main` branch, and it refuses anything else. If something fails, the installer undoes its changes and prints the reason.
