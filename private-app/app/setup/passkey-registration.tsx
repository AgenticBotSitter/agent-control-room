"use client";

import { useLayoutEffect, useState } from "react";

type RegistrationState = Readonly<{ status: "absent" | "working" | "ready" | "failed"; code?: string }>;

const fromBase64url = (value: string): ArrayBuffer => {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
  const decoded = atob(padded), bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes.buffer;
};
const toBase64url = (value: ArrayBuffer): string => {
  const bytes = new Uint8Array(value); let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
};
const responseJson = (credential: PublicKeyCredential) => {
  if (credential.response instanceof AuthenticatorAttestationResponse) return {
    id: credential.id, rawId: toBase64url(credential.rawId), type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: { clientDataJSON: toBase64url(credential.response.clientDataJSON),
      attestationObject: toBase64url(credential.response.attestationObject),
      transports: credential.response.getTransports?.() ?? [] },
  };
  const response = credential.response as AuthenticatorAssertionResponse;
  return { id: credential.id, rawId: toBase64url(credential.rawId), type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: { clientDataJSON: toBase64url(response.clientDataJSON),
      authenticatorData: toBase64url(response.authenticatorData), signature: toBase64url(response.signature),
      userHandle: response.userHandle ? toBase64url(response.userHandle) : null },
  };
};

function publicKeyCreation(value: Record<string, any>): PublicKeyCredentialCreationOptions {
  return { ...value, challenge: fromBase64url(value.challenge), user: { ...value.user, id: fromBase64url(value.user.id) },
    excludeCredentials: (value.excludeCredentials ?? []).map((item: Record<string, any>) => ({ ...item,
      id: fromBase64url(item.id) })) } as PublicKeyCredentialCreationOptions;
}
function publicKeyRequest(value: Record<string, any>): PublicKeyCredentialRequestOptions {
  return { ...value, challenge: fromBase64url(value.challenge), allowCredentials: (value.allowCredentials ?? []).map(
    (item: Record<string, any>) => ({ ...item, id: fromBase64url(item.id) })) } as PublicKeyCredentialRequestOptions;
}

async function comparisonCode(credentialId: string): Promise<string> {
  const id = new Uint8Array(fromBase64url(credentialId));
  const label = new TextEncoder().encode("control-room/passkey-code/v1\0"), joined = new Uint8Array(label.length + id.length);
  joined.set(label); joined.set(id, label.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", joined)), alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0, output = "";
  for (const byte of digest) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { output += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; if (output.length === 6) return output; }
  }
  throw new Error("comparison_code_failed");
}

/** Fragment secrets are copied once and removed before any network request or WebAuthn prompt. */
export function PasskeyRegistration() {
  const [state, setState] = useState<RegistrationState>({ status: "absent" });
  useLayoutEffect(() => {
    if (!window.location.hash) return;
    if (window.location.hash.length > 1024) {
      history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      setState({ status: "failed" }); return;
    }
    const fragment = window.location.hash.slice(1);
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    const values = new URLSearchParams(fragment), registrationSecret = values.get("reg"), ownerCode = values.get("code");
    const mode = values.get("mode");
    if (!registrationSecret || !/^[A-Za-z0-9_-]{43}$/u.test(registrationSecret)
        || ownerCode !== null && (ownerCode.length < 16 || ownerCode.length > 256)
        || values.getAll("reg").length !== 1 || values.getAll("code").length > 1
        || values.getAll("mode").length > 1 || mode !== null && !["initial", "add"].includes(mode)
        || [...values.keys()].some(key => !["reg", "code", "mode"].includes(key))) {
      setState({ status: "failed" }); return;
    }
    const controller = new AbortController(); setState({ status: "working" });
    void (async () => {
      if (ownerCode) {
        const signIn = await fetch("/api/v1/local-owner-session", { method: "POST", credentials: "same-origin",
          cache: "no-store", redirect: "error", signal: controller.signal, headers: { "content-type": "application/json" },
          body: JSON.stringify({ ownerCode }) });
        if (!signIn.ok) throw new Error("sign_in_refused");
      }
      const optionResponse = await fetch("/api/v1/passkeys/registration/options", { method: "POST",
        credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal,
        headers: { "content-type": "application/json" }, body: JSON.stringify({ registrationSecret }) });
      if (!optionResponse.ok) throw new Error("registration_options_refused");
      const options = await optionResponse.json();
      let authorizationAssertion: ReturnType<typeof responseJson> | null = null;
      if (options.authorization?.allowCredentials?.length) {
        try {
          const existing = await navigator.credentials.get({ publicKey: publicKeyRequest(options.authorization),
            signal: controller.signal }) as PublicKeyCredential | null;
          if (existing) authorizationAssertion = responseJson(existing);
        } catch (error) {
          if (controller.signal.aborted) throw error;
          // Continuing without the old passkey is safe: the updater records the
          // new credential inactive for 24 hours. Item 21 will deliver the two
          // notice rows that are recorded for a future sender.
        }
      }
      const created = await navigator.credentials.create({ publicKey: publicKeyCreation(options.publicKey),
        signal: controller.signal }) as PublicKeyCredential | null;
      if (!created) throw new Error("registration_cancelled");
      const response = responseJson(created), code = await comparisonCode(response.id);
      const inserted = await fetch("/api/v1/passkeys/registration", { method: "POST", credentials: "same-origin",
        cache: "no-store", redirect: "error", signal: controller.signal, headers: { "content-type": "application/json" },
        body: JSON.stringify({ registrationSecret, comparisonCode: code, response, authorizationAssertion }) });
      if (!inserted.ok) throw new Error("registration_insert_refused");
      setState({ status: "ready", code });
    })().catch(() => { if (!controller.signal.aborted) setState({ status: "failed" }); });
    return () => controller.abort();
  }, []);
  if (state.status === "absent") return null;
  return <section className="private-panel" aria-labelledby="passkey-registration-title">
    <h2 id="passkey-registration-title">Register Face ID</h2>
    {state.status === "working" && <p role="status">Waiting for Face ID. Keep this page open.</p>}
    {state.status === "ready" && <><p>Type this code in the installer:</p>
      <p role="status" aria-label="Passkey comparison code"><strong>{state.code}</strong></p>
      <p>Type the code above into the installer. A rejected code cancels registration.</p></>}
    {state.status === "failed" && <p role="alert">Registration stopped. Return to the installer and start again. No passkey was activated.</p>}
  </section>;
}
