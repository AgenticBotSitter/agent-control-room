/**
 * The small, hand-maintained inventory of actual top-level private pages.
 *
 * This is deliberately a UI registry, not a discovery mechanism or saved
 * state: later navigation preferences can safely refer to `key` without
 * making routing depend on a database read.
 */
import type { ProductConfigurationV1 } from "../../src/config/v1/product-configuration";

export type PageGroup = "projects" | "workers" | "automation" | "system";
export type PageRegistryRuntimeMode = "checking" | "local" | "hosted";
type ProductModule = keyof ProductConfigurationV1["modules"];

export type PageRegistryEntry = Readonly<{
  key: string;
  title: string;
  href: string;
  group: PageGroup;
  icon: string;
  cadence?: "daily" | "weekly";
  optional?: ProductModule;
  localOnly?: boolean;
  /** The existing header still points at its legacy local sign-out endpoint. */
  headerHref?: string;
  headerTitle?: string;
}>;

export const pageGroupLabels: Readonly<Record<PageGroup, string>> = Object.freeze({
  projects: "Projects & Work",
  workers: "Workers & Connections",
  automation: "Automation",
  system: "System & Setup",
});

export const pageRegistry: readonly PageRegistryEntry[] = Object.freeze([
  { key: "home", title: "Home", href: "/", group: "projects", icon: "home" },
  { key: "morning", title: "Morning summary", href: "/morning", group: "projects", icon: "morning" },
  { key: "projects", title: "Projects", href: "/projects", group: "projects", icon: "projects", cadence: "daily" },
  { key: "workboard", title: "Control Room", href: "/workboard", group: "projects", icon: "work" },
  { key: "needs-me", title: "Action Inbox", href: "/needs-me", group: "projects", icon: "inbox", cadence: "daily" },
  { key: "workers", title: "Workers", href: "/workers", group: "workers", icon: "workers", cadence: "daily" },
  { key: "connections", title: "Connections", href: "/connections", group: "workers", icon: "connections" },
  { key: "session-watch", title: "Session watch", href: "/session-watch", group: "workers", icon: "watch" },
  { key: "ideas", title: "Idea Lab", href: "/ideas", group: "automation", icon: "ideas", optional: "ideaLab" },
  { key: "setup", title: "Setup", href: "/setup", group: "system", icon: "setup" },
  { key: "settings", title: "Settings", href: "/settings", group: "system", icon: "settings" },
  // `/session` is the real route. `headerHref` preserves the legacy header
  // link verbatim until its owner-controlled replacement is separately scoped.
  { key: "session", title: "Session", href: "/session", group: "system", icon: "session", localOnly: true,
    headerHref: "/sign-out", headerTitle: "Sign out" },
]);

/** The exact pre-registry header sequence, now derived from the registry. */
export const headerPageRegistry: readonly PageRegistryEntry[] = Object.freeze([
  "home", "morning", "projects", "workers", "session-watch", "setup", "workboard", "needs-me", "settings", "ideas",
].map(key => {
  const entry = pageRegistry.find(candidate => candidate.key === key);
  if (!entry) throw new Error(`page_registry_header_key_missing:${key}`);
  return entry;
}));

export type PageRegistryVisibility = Readonly<{
  runtimeMode: PageRegistryRuntimeMode;
  enabledProductModules: Readonly<Partial<Record<ProductModule, boolean>>>;
}>;

// Before runtime detection has settled, keep the same conservative shared-page
// set as Mac-local. A failed module-configuration read is likewise never an
// excuse to expose an optional page.
const localVisiblePageKeys = new Set(["home", "morning", "projects", "workers", "session-watch", "needs-me"]);

/** The sole visibility policy for registry-backed navigation. */
export function isPageRegistryEntryVisible(entry: PageRegistryEntry, visibility: PageRegistryVisibility) {
  if (visibility.runtimeMode === "hosted") {
    return !entry.localOnly && (!entry.optional || visibility.enabledProductModules[entry.optional] === true);
  }
  return localVisiblePageKeys.has(entry.key);
}
