"use client";

import { useEffect } from "react";

/** Register only after hydration; failure leaves the ordinary website usable. */
export function PwaRegistration() {
  useEffect(() => {
    if ("serviceWorker" in navigator) void navigator.serviceWorker.register("/service-worker.js", { scope: "/" }).catch(() => {});
  }, []);
  return null;
}
