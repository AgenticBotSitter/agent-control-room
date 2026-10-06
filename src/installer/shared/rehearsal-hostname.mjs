const hostname = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;

export function isRehearsalHostnameV1(value) {
  return typeof value === "string" && hostname.test(value)
    && value.split(".").some(label => label.includes("rehearsal"));
}
