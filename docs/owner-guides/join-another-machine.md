# Join another machine as a worker

Use this guide to let another macOS or Linux computer receive the work you
offer it. The worker never receives your Control Room login, SSH access, or a
database password.

## Before you begin

The new machine needs Node 20 or newer and must be able to reach your Control
Room address. Tailscale Serve works well for this. A Cloudflare Tunnel also
works, but the connector's `/fleet/` route must not be behind the browser
Cloudflare Access sign-in page: the connector uses its own key instead.

You should be able to open the Workers page in Control Room. If you cannot,
sign in on the Control Room computer first.

## Create the one-use join command

1. In Control Room, open **Workers** and choose **Add a worker**.
2. Give the machine a name, choose its agent kind, then select the projects and
   permissions it may have.
3. Choose **Create join code**.

   You should see one command for macOS/Linux and a Windows command. The code
   works once and expires after 10 minutes. If it expires or is refused, make a
   new code rather than editing the old one.

## Join the new machine

1. On the new macOS or Linux machine, paste the exact command Control Room
   shows. Its shape is:

   ```sh
   curl -fsSL https://your-control-room.example/fleet/v1/connector.mjs -o control-room-connector.mjs && node control-room-connector.mjs join --server https://your-control-room.example --code crj_…
   ```

   You should see that the credential was saved and that the next command is
   `node control-room-connector.mjs run`. If the code is refused, it was used,
   cancelled, or expired; create a new code in Control Room.

   If the network drops while joining, run the same command again before the
   10 minutes is up. The worker keeps its pending join information and Control
   Room returns the already-created worker rather than creating another one.

2. Keep the connector running on that machine:

   ```sh
   node control-room-connector.mjs run
   ```

   You should see the machine as **Connected** on Control Room's Workers page
   within a minute. If it does not connect, confirm the Control Room address is
   reachable from that machine and that `/fleet/` is not protected by browser
   Cloudflare Access.

## What to do later

1. Leave the `run` command running whenever that machine should receive work.
   Its private connector key renews while it is running.
2. To remove a lost or unwanted machine, open its **Details** page in Control
   Room and choose **Remove**.

   You should see it stop working immediately. Work it was doing returns to
   the queue when its time runs out; it is not marked complete.

3. To replace a machine's key without removing it, choose **Details → Give it
   a new key**, then run the new join command on that machine. The old key
   stops working.

## If you need an AI agent on the worker

After the machine has joined, the connector can provide the worker's allowed
Control Room tools to an MCP-capable agent. See
[Connect an AI agent to Control Room](../CONNECT_AI_AGENT_MCP.md). This does
not give the agent permission to approve, merge, accept its own work, or give
itself more access.
