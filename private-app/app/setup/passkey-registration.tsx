"use client";

import { useLayoutEffect, useRef, useState } from "react";

type RegistrationState = Readonly<{ status: "absent" | "working" | "ready" | "failed" | "limited" | "sign-in"; code?: string; retryAfterSeconds?: number; message?: string; retry?: boolean }>;

class RegistrationAttemptLimitError extends Error {
  constructor(readonly retryAfterSeconds: number) { super("owner_attempt_limit"); }
}
function requireRegistrationResponse(response: Response, failure: string): void {
  if (response.ok) return;
  if (response.status === 429) {
    const value = response.headers.get("retry-after") ?? "";
    const seconds = Number(value);
    if (/^[0-9]+$/u.test(value) && Number.isSafeInteger(seconds) && seconds > 0)
      throw new RegistrationAttemptLimitError(seconds);
  }
  throw new Error(failure);
}

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
  const retrySignIn = useRef<(() => void) | null>(null);
  const signIn = useRef<((code: string) => void) | null>(null);
  useLayoutEffect(() => {
    let currentFragment = "";
    const start = () => {
    signIn.current = null; retrySignIn.current = null;
    if (!window.location.hash) return;
    if (window.location.hash.length > 1024) {
      history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
      setState({ status: "failed" }); return;
    }
    if (!window.location.hash.includes("=") && document.getElementById(window.location.hash.slice(1))) return;
    currentFragment = window.location.hash;
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
    let working = false;
    const run = (code?: string) => {
      if (working || controller.signal.aborted) return;
      working = true; setState({ status: "working", message: code !== undefined ? "Signing in…" : undefined });
      void (async () => {
        if (code !== undefined) {
          // A request deadline must not abort the component's retained authority:
          // sign-in can be retried, whereas registration failures stay terminal.
          const sessionController = new AbortController();
          const abortSession = () => sessionController.abort();
          controller.signal.addEventListener("abort", abortSession, { once: true });
          const timeout = setTimeout(() => sessionController.abort(), 10_000);
          try {
            const sessionResponse = await fetch("/api/v1/local-owner-session", { method: "POST", credentials: "same-origin",
              cache: "no-store", redirect: "error", signal: sessionController.signal, headers: { "content-type": "application/json" },
              body: JSON.stringify({ ownerCode: code }) });
            if (!sessionResponse.ok) {
              const message = sessionResponse.status === 403
                ? "Sign-in is paused after too many attempts. Wait one minute before trying again."
                : sessionResponse.status === 400 || sessionResponse.status === 401
                  ? code.length !== 43 || /[&=\s]|code/i.test(code)
                    ? "Owner codes are 43 characters. You may have copied extra text. Copy only the owner code, without the link."
                    : "Sign-in was not accepted. Check your owner code and try again."
                  : "Control Room could not sign you in. Try again when the service is available.";
              if (!controller.signal.aborted) setState({ status: "sign-in", message,
                retry: ownerCode !== null && code === ownerCode && sessionResponse.status >= 500 });
              return;
            }
          } catch {
            if (!controller.signal.aborted) setState({ status: "sign-in",
              message: "Could not reach Control Room to sign in. Check your connection and try again on this page.",
              retry: ownerCode !== null && code === ownerCode });
            return;
          } finally {
            clearTimeout(timeout); controller.signal.removeEventListener("abort", abortSession);
          }
          if (controller.signal.aborted) return;
          setState({ status: "working" });
        }
        const optionResponse = await fetch("/api/v1/passkeys/registration/options", { method: "POST",
          credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal,
          headers: { "content-type": "application/json" }, body: JSON.stringify({ registrationSecret }) });
        if (code === undefined && optionResponse.status === 401) {
          if (!controller.signal.aborted) setState({ status: "sign-in" });
          return;
        }
        requireRegistrationResponse(optionResponse, "registration_options_refused");
        const options = await optionResponse.json();
        if (controller.signal.aborted) return;
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
        const response = responseJson(created), displayCode = await comparisonCode(response.id);
        if (controller.signal.aborted) return;
        const inserted = await fetch("/api/v1/passkeys/registration", { method: "POST", credentials: "same-origin",
          cache: "no-store", redirect: "error", signal: controller.signal, headers: { "content-type": "application/json" },
          body: JSON.stringify({ registrationSecret, comparisonCode: displayCode, response, authorizationAssertion }) });
        requireRegistrationResponse(inserted, "registration_insert_refused");
        if (!controller.signal.aborted) setState({ status: "ready", code: displayCode });
      })().catch(error => {
        if (!controller.signal.aborted) setState(error instanceof RegistrationAttemptLimitError
          ? { status: "limited", retryAfterSeconds: error.retryAfterSeconds } : { status: "failed" });
      }).finally(() => { working = false; });
    };
    // Keep the already-cleared fragment in this effect's closure during sign-in.
    signIn.current = code => run(code);
    retrySignIn.current = () => run(ownerCode ?? undefined);
    run(ownerCode ?? undefined);
    return () => { signIn.current = null; retrySignIn.current = null; controller.abort(); };
    };
    let stop = start();
    const onHashChange = () => {
      const nextFragment = window.location.hash;
      if (!new URLSearchParams(nextFragment.slice(1)).has("reg")) return;
      if (nextFragment === currentFragment) {
        history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
        return;
      }
      stop?.();
      setState({ status: "absent" });
      stop = start();
    };
    window.addEventListener("hashchange", onHashChange);
    return () => { window.removeEventListener("hashchange", onHashChange); stop?.(); };
  }, []);
  if (state.status === "absent") return null;
  return <section className="private-panel" aria-labelledby="passkey-registration-title">
    <h2 id="passkey-registration-title">Register Face ID</h2>
    {state.status === "sign-in" && <form onSubmit={event => {
      event.preventDefault();
      const code = String(new window.FormData(event.currentTarget).get("ownerCode") ?? "").replace(/^ | $/g, "");
      signIn.current?.(code);
    }}>
      {state.retry ? <button type="button" onClick={() => retrySignIn.current?.()}>Try again</button> : <>
      <p>Enter the 43-character owner code printed in the Terminal window where you installed Control Room. If that window is unavailable, ask the lead.</p>
      <label htmlFor="setup-owner-code">Owner code</label>
      <input id="setup-owner-code" name="ownerCode" type="password" autoComplete="off" required />
      <button type="submit">Sign in and continue</button></>}
      {state.message && <p role="alert">{state.message}</p>}
    </form>}
    {state.status === "working" && <p role="status">{state.message ?? "Waiting for Face ID. Keep this page open."}</p>}
    {state.status === "ready" && <><p>Type this code in the installer:</p>
      <p role="status" aria-label="Passkey comparison code"><strong>{state.code}</strong></p>
      <p>Type the code above into the installer. A rejected code cancels registration.</p></>}
    {state.status === "limited" && <p role="alert">Too many tries — wait {state.retryAfterSeconds} seconds</p>}
    {state.status === "failed" && <p role="alert">Registration stopped. No passkey was activated. Do not retry or reload this page. Keep the Terminal message and show the lead after reopening Claude.</p>}
  </section>;
}
