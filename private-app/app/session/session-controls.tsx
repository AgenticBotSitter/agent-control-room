"use client";
import { useState } from "react";
import { BrowserRequestError, browserErrorMessage, createProjectBrowserClient } from "../../../src/web/v1/browser-client";
export function SessionControls() {
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  return <><button type="button" disabled={pending} onClick={() => {
    if (pending) return; setPending(true);
    void createProjectBrowserClient().logout().then(path => window.location.assign(path)).catch(error => {
      setMessage(browserErrorMessage[error instanceof BrowserRequestError ? error.code : "unavailable"]); setPending(false);
    });
  }}>{pending ? "Signing out…" : "Sign out"}</button>{message && <p role="alert">{message}</p>}</>;
}
