/** Fixed, inert fixture protocol for the unmounted Hermes native custodian. */
export const MACOS_HERMES_NATIVE_LAUNCH_CUSTODIAN_FRAME_BYTES_V1 = 280 as const;
export const MACOS_HERMES_NATIVE_LAUNCH_CUSTODIAN_RESPONSE_BYTES_V1 = 16 as const;

export function decodeMacosHermesNativeLaunchCustodianResponseV1(value: Uint8Array) {
  if (!(value instanceof Uint8Array) || value.byteLength !== MACOS_HERMES_NATIVE_LAUNCH_CUSTODIAN_RESPONSE_BYTES_V1) throw refused();
  const bytes = Buffer.from(value);
  if (!bytes.subarray(0, 4).equals(Buffer.from("ACRS", "ascii")) || bytes[4] !== 1 || bytes[5] !== 4
    || bytes[6] !== 1 || bytes[7] !== 0 || bytes.readUInt32BE(8) !== 1 || bytes.readUInt32BE(12) !== 0) throw refused();
  return Object.freeze({ frameValidated: true as const, launchesHermes: false as const,
    cleanup: "refused_no_owned_process_group" as const, grantsLaunchAuthority: false as const });
}

function refused(): Error { const error = new Error("macos_hermes_native_launch_custodian_contract_refused"); error.stack = undefined; return error; }
