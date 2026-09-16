// Operator configuration example for the unprivileged Control Room host.
//
// Copy to ~/control-room-config.mjs, `chmod 600`, and keep it owner-only.
// The preflight refuses a configuration that is world-readable, group-readable,
// or reached through a symlink, so custody of this file is part of the contract.
//
// This module supplies VALUES, not a running service. Nothing here binds a
// socket, opens a database, or starts a listener on import — the host does that
// when the supervised unit starts it.
//
// Secrets: read them from the environment at start time (see `readSecret`), and
// never commit a real value into this file.

/** Read a required secret from the environment, failing loudly when absent. */
function readSecret(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value === "") {
    throw new Error(`control_room_configuration_secret_missing:${name}`);
  }
  return value;
}

export default {
  // Loopback only. The unit files grant no public interface.
  host: "127.0.0.1",
  port: 8787,

  // Release root laid out by the release path: releases/, current/, state/.
  releaseRoot: process.env.CONTROL_ROOM_ROOT || `${process.env.HOME}/control-room`,

  // Durable state. The release path never writes inside this directory: staged
  // update and rollback leave it untouched so accepted work survives both.
  stateDir: `${process.env.CONTROL_ROOM_ROOT || `${process.env.HOME}/control-room`}/state`,

  // Uncertain-work markers. Present markers cause update and rollback to refuse
  // until an operator resolves them explicitly.
  uncertainDir: `${process.env.CONTROL_ROOM_ROOT || `${process.env.HOME}/control-room`}/uncertain`,

  // Bounded log for the release path.
  logPath: `${process.env.CONTROL_ROOM_ROOT || `${process.env.HOME}/control-room`}/update.log`,

  // Storage connection. Point at a local database; the release archive does not
  // carry credentials or a database, only the schema migrations it needs.
  database: {
    host: process.env.CONTROL_ROOM_DB_HOST || "127.0.0.1",
    port: Number(process.env.CONTROL_ROOM_DB_PORT || 5432),
    name: process.env.CONTROL_ROOM_DB_NAME || "control_room",
    user: process.env.CONTROL_ROOM_DB_USER || "control_room",
    password: readSecret("CONTROL_ROOM_DB_PASSWORD"),
  },

  // Operator-configurable limits. Bounded so a misconfiguration cannot exhaust
  // the host: the service logs to the journal and never to an unbounded file.
  limits: {
    maxConcurrentRuns: 2,
    requestTimeoutMs: 30_000,
    logMaxBytes: 256 * 1024,
  },

  // Feature switches. Keep the release installable with every optional path off.
  features: {
    scheduledDispatch: true,
    resultPublication: true,
  },
};