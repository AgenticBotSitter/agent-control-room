import type { JSX } from "react";
import type { ScheduleProjectionV1, ServiceProjectionV1 } from "@/src/operator-surfaces/v1/types";

function label(value: string): string {
  return value.replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

/** Displays protected observations only. It neither exposes a schedule expression nor offers a service control. */
export function ServiceScheduleList(props: { services: readonly ServiceProjectionV1[]; schedules: readonly ScheduleProjectionV1[] }): JSX.Element {
  const { services, schedules } = props;
  return (
    <div className="service-schedule-grid">
      <section aria-labelledby="protected-services-heading">
        <h3 id="protected-services-heading">Services</h3>
        {services.length === 0 ? <p className="empty-state">No protected services are currently recorded.</p> : <ol className="service-list" aria-label="Protected services">
          {services.map((service) => (
            <li key={service.serviceId} className={`service-projection state-${service.state}`}>
              <div><span>{label(service.state)}</span><small>{service.serviceType}</small></div>
              <h4>{service.serviceId}</h4>
              <p>Project {service.projectId}{service.statusCode ? ` · ${label(service.statusCode)}` : ""}</p>
              <small>{service.lastObservedAt ? `Last observed ${service.lastObservedAt}` : "No observation time recorded"}{service.lastHealthyAt ? ` · Last healthy ${service.lastHealthyAt}` : ""}</small>
            </li>
          ))}
        </ol>}
      </section>
      <section aria-labelledby="protected-schedules-heading">
        <h3 id="protected-schedules-heading">Schedules</h3>
        {schedules.length === 0 ? <p className="empty-state">No protected schedules are currently recorded.</p> : <ol className="schedule-list" aria-label="Protected schedules">
          {schedules.map((schedule) => (
            <li key={schedule.scheduleId} className={`schedule-projection state-${schedule.state}`}>
              <div><span>{label(schedule.state)}</span><small>{label(schedule.scheduleType)} · {schedule.timezone}</small></div>
              <h4>{schedule.scheduleId}</h4>
              <p>Targets {label(schedule.targetType)} {schedule.targetId} · idempotency window {schedule.idempotencyWindowSeconds}s</p>
              <small>{schedule.nextRunAt ? `Next recorded run ${schedule.nextRunAt}` : "No next run recorded"}. This is status, not a dispatch control.</small>
            </li>
          ))}
        </ol>}
      </section>
    </div>
  );
}
