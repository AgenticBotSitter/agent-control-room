#ifndef ACR_TEST_MACOS_SUSPENDED_MAPPED_VNODE_OBSERVATION_H
#define ACR_TEST_MACOS_SUSPENDED_MAPPED_VNODE_OBSERVATION_H

/*
 * TEST-ONLY negative-evidence probe. This is not executable attestation and
 * must not authorize SIGCONT or qualification. Darwin has no public fexecve
 * equivalent. START_SUSPENDED plus this mapped-vnode observation detects a
 * pathname replacement to another inode, but an open O_RDONLY descriptor does
 * not make the held inode's bytes immutable. A same-inode mutate/load/restore
 * race remains, as does mutable dependency code. A script maps its interpreter
 * rather than the reviewed script. The adversarial test preserves all three
 * facts so this partial observation cannot be mistaken for a pinned launcher.
 */
#ifndef __APPLE__
#error "macOS-only negative-evidence probe"
#endif

#include <sys/proc.h>
#include <sys/proc_info.h>
#include <sys/stat.h>
#include <mach/vm_prot.h>
#include <libproc.h>
#include <stdint.h>
#include <unistd.h>

static int acr_test_macos_suspended_mapped_vnode_matches(
    pid_t child, pid_t expected_parent, uid_t expected_owner,
    const struct stat *held_executable) {
  if (child <= 0 || expected_parent <= 0 || held_executable == NULL
      || !S_ISREG(held_executable->st_mode) || held_executable->st_ino == 0)
    return -1;
  struct proc_bsdinfo process;
  if (proc_pidinfo(child, PROC_PIDTBSDINFO, 0, &process, sizeof(process))
          != (int)sizeof(process)
      || process.pbi_pid != (uint32_t)child
      || process.pbi_ppid != (uint32_t)expected_parent
      || process.pbi_status != SSTOP
      || process.pbi_uid != expected_owner
      || process.pbi_ruid != expected_owner
      || process.pbi_svuid != expected_owner
      || (process.pbi_flags & PROC_FLAG_TRACED) != 0)
    return -1;
  uint64_t address = 0;
  for (size_t index = 0; index < 256; index++) {
    struct proc_regionwithpathinfo region;
    if (proc_pidinfo(child, PROC_PIDREGIONPATHINFO, address, &region,
          sizeof(region)) != (int)sizeof(region)) return -1;
    if ((region.prp_prinfo.pri_protection & VM_PROT_EXECUTE) != 0
        && region.prp_vip.vip_vi.vi_stat.vst_ino != 0)
      return region.prp_vip.vip_vi.vi_stat.vst_dev
              == (uint32_t)held_executable->st_dev
          && region.prp_vip.vip_vi.vi_stat.vst_ino
              == held_executable->st_ino ? 0 : -1;
    uint64_t next = region.prp_prinfo.pri_address + region.prp_prinfo.pri_size;
    if (next <= address || next < region.prp_prinfo.pri_address) return -1;
    address = next;
  }
  return -1;
}

#endif
