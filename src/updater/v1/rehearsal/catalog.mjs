const runnable = (id, title, implementation) => Object.freeze({ id, title, implementation });
const pending = (id, title, needs) => Object.freeze({ id, title, pending: `needs ${needs}` });
const phase = (id, title, scenarios) => Object.freeze({ id, title, scenarios: Object.freeze(scenarios) });

/**
 * Acceptance inventory from UPDATER_SAFETY_DESIGN section 13. Entries stay
 * granular so an unavailable future item cannot make a partially exercised P
 * case look green.
 */
export const REHEARSAL_CASES_V1 = Object.freeze([
  phase("P0", "Isolation", [
    runnable("P0.root-safety", "disposable root, owners, accounts, ports and origin are asserted", "root_safety"),
    runnable("P0.lower-writable-swaps", "root file helpers refuse symlink and hardlink swaps", "filesystem_swaps"),
    runnable("P0.no-owner-code-or-clipboard", "fixture has no owner-code file and never invokes a clipboard tool", "absence_checks"),
    pending("P0.identity-matrix", "complete bot-identity read, write, exec, socket and signal matrix",
      "item 25 real-root identity run on the owners-enabled rehearsal image"),
  ]),
  phase("P1", "Happy paths", [
    pending("P1.a", "owner request through real-phone install", "items 10a, 10b, 11, 14, 17, 20 and 23"),
    pending("P1.b", "additive migration with N-1 boot", "items 12 and 18"),
    pending("P1.c", "protected candidate shows a red card", "items 16 and 20"),
    pending("P1.d", "dependency change shows a protected card", "items 16 and 20"),
    pending("P1.e", "two-phase updater self-upgrade", "items 8b, 10a and 14"),
    pending("P1.f", "attended install commit path", "item 11a"),
  ]),
  phase("P2", "Crash at every step", [
    runnable("P2.code-journal-points", "kill the updater after every code intent and done record", "code_crash_points"),
    runnable("P2.torn-pair-switch", "tear each pair-link switch and recover old or new as one pair", "torn_switch"),
    pending("P2.database-journal-points", "kill at every DB and restore journal point", "item 18 and Marvin DB phase"),
    pending("P2.daemon-kills", "immediate DB stop and five daemon kill points", "item 18 and real-root services"),
    pending("P2.real-reboot", "owner-approved reboot during DB upgrade", "item 18 and install-night quiet window"),
  ]),
  phase("P3", "Time", [
    pending("P3.plan-expiry", "stopped updater requires a fresh approval", "item 22"),
    runnable("P3.clock-environment", "hostile clock-related environment cannot enter trusted spawns", "hostile_environment"),
    pending("P3.sleep-build", "machine sleep during build resumes or reports", "item 11 and real-root execution"),
  ]),
  phase("P4", "Disk", [
    runnable("P4.preflight-full", "insufficient space refuses before staging", "disk_preflight"),
    runnable("P4.enospc-recovery", "reserve is released once and rebuilt after a retry", "disk_reserve_retry"),
    pending("P4.database-full-points", "disk full during dump, after preimage and mid-migrate", "item 18 and Marvin DB phase"),
  ]),
  phase("P5", "Network", [
    pending("P5.fetch-cut", "network loss during fetch", "items 11 and 17"),
    pending("P5.after-quiesce", "network loss after quiesce", "item 18"),
  ]),
  phase("P6", "Concurrency", [
    runnable("P6.lease-burst", "twenty concurrent in-process calls admit one updater runner", "runner_lease_burst"),
    pending("P6.production-process-lease", "twenty OS processes contend through the production-role store",
      "item 10a production-role store and Marvin DB phase"),
    pending("P6.approval-burst", "twenty approvals for two plans yield one run", "item 10a and Marvin DB phase"),
    pending("P6.latest-merge", "two nearby merges choose the latest", "item 17"),
    pending("P6.gateway-quiesce", "gateway writer gets 503 and retries consistently", "item 18"),
  ]),
  phase("P7", "Hostile candidate", [
    runnable("P7.bundle-extra", "an undeclared updater bundle file is refused", "bundle_tamper"),
    runnable("P7.bundle-symlink", "a symlink in an updater bundle is refused", "bundle_symlink"),
    runnable("P7.hostile-environment", "candidate environment overrides are stripped or refused", "hostile_environment"),
    pending("P7.postinstall", "postinstall secret read, current write, network and leftover process", "item 11"),
    pending("P7.package-manager-files", "candidate package-manager control files and registry swap", "item 11"),
    pending("P7.lying-health", "lying health code", "item 14"),
    pending("P7.lying-metadata", "lying metadata and install-screen edit", "items 16 and 20"),
    pending("P7.protected-edits", "path rules, guard tests, DB roles and security reverts stay protected", "item 16"),
    pending("P7.mac-up", "candidate service-start script is refused", "item 11"),
    pending("P7.cron-at", "scheduled-job install is refused and the job-start scan catches it", "item 11"),
    pending("P7.adoption-race", "editing process is killed before adoption", "item 11a"),
    pending("P7.runner-patch", "always-pass test runner does not change class or card", "items 11 and 16"),
    pending("P7.export-ignore", "guard export-ignore is refused by the tree check", "item 11a"),
    pending("P7.rename", "both sides of a protected rename are classified", "item 16"),
    pending("P7.updater-symlink", "added symlink into updater is protected", "item 16"),
    pending("P7.fixed-step-wins", "fixed-step updater bundle wins over the candidate bundle", "item 11a"),
  ]),
  phase("P8", "Hostile local bot", [
    runnable("P8.lower-writable-swaps", "symlink and hardlink swaps do not touch an outside target", "filesystem_swaps"),
    runnable("P8.runtime-trojans", "hostile path and process environment cannot select tools", "hostile_environment"),
    runnable("P8.known-good-injection", "an injected known-good identifier is refused before effects", "known_good_injection"),
    pending("P8.custody-forgeries", "custody reads, journal forgery, approval forgery and replay", "items 10a and 15"),
    pending("P8.stolen-cookie", "stolen cookie cannot approve", "item 10a"),
    pending("P8.signal", "bot cannot signal updater", "item 25 real-root identity run on the rehearsal image"),
    pending("P8.root-parent-rename", "install-root parent rename is denied",
      "item 25 real-root identity run on the rehearsal image"),
    pending("P8.clipboard-poll", "approval material never enters the clipboard", "item 10a"),
    pending("P8.serve-change", "Serve drift freezes approval and pushes", "items 10b and 21"),
    pending("P8.sudo-shim", "planted command and hostile sudo environment cannot replace the root shim", "item 4 real-root run"),
    pending("P8.origin-and-port", "wrong-origin assertion and a second Serve port are refused", "items 10a and 10b"),
    pending("P8.registration-race", "two registrations and a wrong six-character code are refused", "item 10a"),
    pending("P8.approval-flood", "junk approval flood stays bounded and rate limited", "items 10a and 21"),
    pending("P8.health-auth", "unauthenticated health requests are refused", "item 14"),
    pending("P8.push-host", "non-push subscription endpoint is never contacted", "item 21"),
  ]),
  phase("P9", "Broken releases", [
    runnable("P9.rollback-chain", "rollback skips a corrupt pair and selects an older healthy pair", "rollback_chain"),
    runnable("P9.all-links-revert", "a failed self-upgrade reverts every updater and runtime link", "guard_all_links"),
    pending("P9.health-failures", "owner, gateway, worker and slow-start failures auto-roll back", "item 14"),
    pending("P9.phone-rollback", "phone rollback follows the same chain", "items 10a and 20"),
    pending("P9.all-broken", "all broken yields needs-attention and push while host is down", "items 14 and 21"),
    pending("P9.pg-pin", "broken database runtime pin fails Phase D and reverts all links", "items 3b and 14"),
  ]),
  phase("P10", "Journal and restore", [
    pending("P10.poisoned-journal", "duplicate ordinal becomes uncertain", "item 15"),
    pending("P10.db-behind", "display refreshes when DB is behind the file", "item 15 and Marvin DB phase"),
    pending("P10.db-ahead", "check-and-continue settles DB ahead of file", "item 15 and Marvin DB phase"),
    pending("P10.restore-resume", "killed restore resumes", "item 18 and Marvin DB phase"),
    pending("P10.backup-verify", "failed verification prevents migrate", "item 18 and Marvin DB phase"),
    pending("P10.corrupt-preimage", "corrupt preimage restores to scratch as migrator", "item 18 and Marvin DB phase"),
    pending("P10.rescue-reboot-persistence", "P2/P10 rescue then reboot keeps the rescued pair",
      "item 13 rescue persistence fix and item 25 real-root reboot rehearsal"),
  ]),
  phase("P11", "Owner controls", [
    runnable("P11.pause-stop-code", "pause and stop are checked at every code state", "pause_stop"),
    runnable("P11.rescue-code-points", "rescue at every code kill point returns a pair and leaves uncertain evidence", "guard_rescue_points"),
    pending("P11.rescue-db-points", "rescue at every DB kill point does not re-advance", "item 18 and Marvin DB phase"),
    runnable("P11.failed-heartbeat-links", "stale heartbeat rescue reverts updater and runtime links", "guard_all_links"),
  ]),
  phase("P12", "Load", [
    pending("P12.host-load", "full happy path at host load near fourteen avoids false rollback", "items 10a, 11, 14, 17, 20, 23 and real-root load run"),
  ]),
  phase("P13", "Trusted runtime", [
    runnable("P13.environment", "trusted spawns ignore hostile developer and provider environment", "hostile_environment"),
    runnable("P13.profile-shape", "every service profile denies untrusted program roots", "profile_shape"),
    pending("P13.running-identities", "each running service identity is denied read and exec",
      "item 25 real-root identity run on the owners-enabled rehearsal image"),
    pending("P13.provider-module", "database runtime does not load a planted provider module", "item 3b and Marvin DB phase"),
    pending("P13.static-process-scan", "process, open-file and loaded-library scan is clean",
      "item 25 real-root service run on the rehearsal image"),
  ]),
  phase("DB-R8", "DB stop race", [
    pending("DB-R8.preimage", "lingering client cannot race launchd during preimage", "item 18 and Marvin DB phase"),
    pending("DB-R8.restore", "lingering client cannot race launchd during restore", "item 18 and Marvin DB phase"),
  ]),
]);
