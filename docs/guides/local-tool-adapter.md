# Add a local Whisper tool on a Mac

A local tool adapter lets this Mac run one program that you choose. Control Room can name the adapter, but it cannot send a program path, shell command, flags, or environment variables. Results still come back for your review; they are not accepted automatically.

## 1. Check the Whisper executable

Install and test Whisper yourself first. Then find its absolute path:

```sh
command -v whisper
```

On an Apple Silicon Mac this is often `/opt/homebrew/bin/whisper`; on an Intel Mac it may be `/usr/local/bin/whisper`. Use the path the command printed. The connector refuses relative paths and files that other users can modify.

## 2. Create the manifest

The manifest must be named `tool-adapters.json` and sit beside `connector.json` in the connector's configuration directory. If `CONTROL_ROOM_CONNECTOR_CONFIG` points to a custom credential file, put the manifest beside that file. Otherwise the directory is `$XDG_CONFIG_HOME/control-room` when `XDG_CONFIG_HOME` is set.

Create this JSON, replacing only the executable path if yours differs:

```json
{
  "schema": "control-room.local-tool-adapters/v1",
  "maxConcurrent": 1,
  "adapters": [
    {
      "id": "whisper_local",
      "capability": "tool.whisper",
      "executable": "/opt/homebrew/bin/whisper",
      "arguments": [
        "{input:audio}",
        "--output_dir",
        "{output:transcript}",
        "--output_format",
        "txt"
      ],
      "timeoutMs": 1800000,
      "maxOutputBytes": 1048576,
      "envAllowlist": ["HOME", "PATH"]
    }
  ]
}
```

Protect it:

Run `node control-room-connector.mjs help` to see the connector credential location, then run `chmod 600` on the `tool-adapters.json` beside it.

`{input:audio}` is a file placed in a new private temporary directory for that run. `{output:transcript}` is a new empty directory. Whisper receives both as separate arguments; no shell interprets them. Only files Whisper puts below the output directory are considered for upload.

## 3. Add and run the worker

In **Workers**, choose **Add a worker**, select **Local tool adapter**, and grant only the projects and **Whisper transcription** capability it needs. Run the one-time join command on this Mac, then start the connector normally:

```sh
node control-room-connector.mjs run
```

The connector reports `tool.whisper` as observed evidence. That report does not grant the capability; the capability you approved in Workers remains the ceiling.

## What the connector refuses

It refuses an unknown adapter id, a changed or unsafe manifest, relative executables, shell characters or partial placeholders in arguments, missing inputs, excess concurrent runs, timeouts, oversized output, symbolic links, unsupported file types, and output containing recognizable secrets. A timeout or Stop terminates the process group and removes the temporary directory.

To change the executable or flags, stop the connector, edit the local manifest yourself, test Whisper directly, and restart the connector. Never paste credentials into the manifest or add secret-bearing variables to `envAllowlist`.
