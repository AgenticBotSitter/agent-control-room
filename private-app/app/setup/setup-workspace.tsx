"use client";

import { useEffect, useState } from "react";
import { parseInstallationSetupViewV1, type InstallationSetupViewV1 } from "../../../src/harness/v1/installation-setup-wire";
import { verifyInstallationPlanViewV1, type InstallationPlanViewV1 } from "../../../src/installer/v1/installation-plan-view";
import { LocalInstallationWizard } from "../local-installation-wizard";

type SetupReadState = Readonly<{
  status: "loading" | "available" | "unavailable";
  setup?: InstallationSetupViewV1;
  installationPlanStatus: "loading" | "available" | "unavailable";
  installationPlan?: InstallationPlanViewV1;
}>;

// These are the only browser reads made by the standalone setup route. They
// are fixed, authenticated setup-host paths and return browser-safe views.
const readinessPath = "/api/v1/installation-readiness";
const planPath = "/api/v1/installation-plan";
const loadingState: SetupReadState = Object.freeze({ status: "loading", installationPlanStatus: "loading" });
const unavailableState: SetupReadState = Object.freeze({ status: "unavailable", installationPlanStatus: "unavailable" });

/**
 * Read-only setup presentation. It does not mount project navigation, session
 * controls, product configuration, or any setup action.
 */
export function SetupWorkspace() {
  const [state, setState] = useState<SetupReadState>(loadingState);

  useEffect(() => {
    const controller = new AbortController();
    let request = 0;
    const load = async () => {
      const current = ++request;
      try {
        const [readinessResponse, planResponse] = await Promise.all([
          fetch(readinessPath, { method: "GET", credentials: "omit", cache: "no-store",
            redirect: "error", signal: controller.signal }),
          fetch(planPath, { method: "GET", credentials: "omit", cache: "no-store",
            redirect: "error", signal: controller.signal }),
        ]);
        const setup = readinessResponse.ok
          ? parseInstallationSetupViewV1((await readinessResponse.json()).setup) : undefined;
        const installationPlan = planResponse.ok
          ? verifyInstallationPlanViewV1((await planResponse.json()).plan) : undefined;
        const next: SetupReadState = Object.freeze({
          status: setup ? "available" : "unavailable",
          ...(setup ? { setup } : {}),
          installationPlanStatus: installationPlan ? "available" : "unavailable",
          ...(installationPlan ? { installationPlan } : {}),
        });
        if (!controller.signal.aborted && current === request) setState(next);
      } catch {
        // A prior successful read must not remain visible after a malformed,
        // refused, or interrupted response.
        if (!controller.signal.aborted && current === request) setState(unavailableState);
      }
    };
    void load();
    return () => controller.abort();
  }, []);

  return <main id="private-main" className="private-shell" tabIndex={-1}>
    <section className="private-heading" aria-labelledby="setup-page-title">
      <p className="private-eyebrow">Source-only setup preview</p>
      <h1 id="setup-page-title">Set up Control Room</h1>
      <p><strong>The macOS bundle source exists, but a public release and live installation do not.</strong> This page shows only saved, browser-safe setup status and progress; it cannot install, start, enable, or configure Control Room.</p>
    </section>
    <LocalInstallationWizard setup={state.setup} status={state.status}
      installationPlan={state.installationPlan} installationPlanStatus={state.installationPlanStatus} />
  </main>;
}
