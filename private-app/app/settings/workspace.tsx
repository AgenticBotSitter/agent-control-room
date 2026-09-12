"use client";

import { PrivateHeader } from "../private-header";
import { useProductConfiguration } from "../product-configuration";
import { ProductConfigurationSummary } from "../product-configuration-summary";

export function PrivateSettingsWorkspace() {
  const configuration = useProductConfiguration();
  return <div className="private-shell"><PrivateHeader /><main id="private-main">
    <section className="private-heading" aria-labelledby="settings-title">
      <p className="private-eyebrow">Private workspace</p>
      <h1 id="settings-title">Settings</h1>
      <p>This screen documents the boundaries of the current private session. It does not expose credentials, connection secrets, or portable private records.</p>
    </section>
    <div className="private-settings-grid">
      <section className="private-panel" aria-labelledby="session-title">
        <h2 id="session-title">Session</h2>
        <p>Your current session controls access to this private workspace. Signing out is handled on the dedicated session page.</p>
        <a className="private-action-link" href="/session">Open session and sign out</a>
      </section>
      <section className="private-panel" aria-labelledby="security-title">
        <h2 id="security-title">Security and limits</h2>
        <p>Project work and connection records remain protected by the current access policy. This application does not use this page to configure credentials or start external services.</p>
        <p className="private-note">For the latest saved worker signals, use Workers. A signal is a recorded check, not a claim of continuous availability.</p>
        <a className="private-action-link" href="/workers">Review workers</a>
      </section>
    </div>
    <ProductConfigurationSummary configuration={configuration} />
  </main></div>;
}
