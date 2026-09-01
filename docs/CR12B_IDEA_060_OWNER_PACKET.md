# CR12B-IDEA-060 owner-attended local pilot

This packet runs one local, non-production, repository-fake Idea Lab pilot on the attached Mac. It does not contact
Hermes, Codex, a local model, PostgreSQL on the VPS, a public host, or any provider. It installs no service and runs only
in the foreground on `127.0.0.1:3000`.

## Owner steps

From the repository root, run these commands yourself:

```bash
npm run pilot:idea:prepare -- --owner-attended
npm run pilot:idea:start -- --owner-attended
```

`prepare` stores one random master key in the owner's macOS Keychain and prints a separate one-time owner code exactly
once. The repository never receives either value. `start` may cause a Keychain confirmation; the owner must approve or
deny it personally. Open `http://127.0.0.1:3000/ideas`, enter the one-time code, and complete this bounded flow:

1. create an Idea Lab session;
2. run the repository-fake panel;
3. synthesize the fake contributions;
4. create a monitored project;
5. open the new project page;
6. pause and resume it from Settings;
7. reload the page and confirm the session and project remain present;
8. stop the foreground server with Control-C, start it once more with the same start command, and confirm the same
   session and project are still present before the 15-minute owner session expires.

Stop immediately if the page claims a live provider is configured, binds anywhere other than `127.0.0.1`, requests a
provider credential, contacts the VPS, or shows unlabelled fixture data as protected truth. Retain only safe result,
counts, timestamps, and digests. Do not copy the owner code, cookie, Keychain value, local data path, username, or raw
host identity into an issue, commit, pull request, screenshot, or acceptance record.

The foreground process is the whole runtime. Control-C is teardown; no daemon or auto-start item remains. Local pilot
data and the Keychain item are deliberately retained after the run for restart evidence and are not deleted by this
packet.
