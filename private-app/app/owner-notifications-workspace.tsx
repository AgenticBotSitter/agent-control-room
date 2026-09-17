"use client";

import { useEffect, useState } from "react";
import { NotificationSettingsSurface } from "./notification-settings";
import { readOwnerNotificationsV1, unavailableOwnerNotificationsV1 } from "../../src/web/v1/owner-notifications-browser-client";
import type { OwnerNotificationsViewV1 } from "../../src/web/v1/owner-notifications-browser-client";

export function OwnerNotificationsPanel({ view, loading = false }: { view: OwnerNotificationsViewV1; loading?: boolean }) {
  return <div>
    <p className="private-note">This Settings panel uses a fixed read-only default: all projects, routine priority and above,
      no quiet hours. It does not load or save an owner policy. Completion/failure job-outcome notifications are not shown:
      the operator surface reader provides only owner-attention items and service incidents, not job-outcome history.</p>
    <p className="private-note">The surface below is mounted here in Settings; its inherited “not yet mounted” status refers
      to the original standalone surface. No owner policy endpoint is called. These rows preview decisions only;
      no notification is delivered or acknowledged.</p>
    {loading ? <p role="status">Loading saved notification sources…</p> : null}
    <NotificationSettingsSurface settings={view.settings} decisions={view.plan.decisions} />
  </div>;
}

export function OwnerNotificationsWorkspace() {
  const [view, setView] = useState<OwnerNotificationsViewV1>(unavailableOwnerNotificationsV1);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let current = true;
    void readOwnerNotificationsV1().then(next => {
      if (current) { setView(next); setLoading(false); }
    });
    return () => { current = false; };
  }, []);
  return <OwnerNotificationsPanel view={view} loading={loading} />;
}
