// EXAMPLE operator configuration — generic placeholder values only. Copy OUTSIDE
// the repo (e.g. /home/operator/control-room-config.mjs), substitute every
// bracketed value, chmod 0600, chown to the service UID. Never commit the copy.
// Shape-checked by tests/release-example-config.test.ts against the REAL
// validators (requirePrivateVpsMode + validatePrivateStartupConfiguration).
export const schema = "control-room.private-vps-configuration/v1";

export async function createConfiguration({ signal }) {
  if (signal?.aborted) throw new Error("private_vps_start_canceled");
  return {
    // Website-only: serves pages, no agent execution. See run-private-vps.mjs
    // for the agent-tasks mode and its additional required fields.
    mode: "website-only",
    port: 3000, // loopback only; the host binds 127.0.0.1
    nativeHttps: null,
    configuration: {
      web: {
        origin: "https://control-room.example.com",
        issuer: "https://control-room.example.com",
        audience: "control-room-operator",
        tenantId: "example-tenant",
        workspaceId: "example-workspace",
        ownerIdentityId: "example-owner",
        maxSessionSeconds: 900,
        // Load signing keys from YOUR secret management at startup.
        // Must return the key map the deployment provisioned; never hardcode keys.
        loadKeys: async () => { throw new Error("operator_loadKeys_not_configured"); },
        database: {
          host: "127.0.0.1", // only loopback is accepted
          port: 5432,
          majorVersion: 17,
          database: "control_room",
          username: "control_room_app",
          // Password via YOUR secret management, never hardcoded here.
          password: "REPLACE_VIA_SECRET_MANAGER",
        },
      },
    },
  };
}
