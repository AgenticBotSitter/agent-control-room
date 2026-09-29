/* Deliberately small: payload data is generic and click handling only follows a local path. */
self.addEventListener("push", event => {
  let payload = { title: "Control Room", link: "/needs-me", tag: "control-room" };
  try { const candidate = event.data.json(); if (candidate && typeof candidate.title === "string" && typeof candidate.link === "string"
    && candidate.link.startsWith("/") && !candidate.link.startsWith("//") && typeof candidate.tag === "string") payload = candidate; } catch {}
  event.waitUntil(self.registration.showNotification(payload.title, { body: "Open Control Room to view the saved item.", tag: payload.tag,
    data: { link: payload.link }, renotify: false }));
});
self.addEventListener("notificationclick", event => {
  event.notification.close(); const link = event.notification.data?.link;
  if (typeof link !== "string" || !link.startsWith("/") || link.startsWith("//")) return;
  event.waitUntil(clients.openWindow(link));
});
