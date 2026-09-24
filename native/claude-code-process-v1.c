/*
 * ACRCCP1: one fixed, source-only Claude text-review process custodian.
 * No shell, credentials, inherited environment, argv extension or discovery.
 * fd 0 = control; fd 1 = bounded status; fd 2 = unused;
 * fd 3/4/5 = target stdin/stdout/stderr, inherited only as target 0/1/2.
 * Installation and qualification are separate owner-attended gates.
 */
#ifndef __APPLE__
#error "ACRCCP1 requires macOS"
#endif
#define _DARWIN_C_SOURCE
#define CC_DISABLE_DEPRECATION
#include <CommonCrypto/CommonDigest.h>
#include <sys/acl.h>
#include <sys/proc.h>
#include <sys/proc_info.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <mach/mach.h>
#include <mach-o/loader.h>
#include <libproc.h>
#include <spawn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define MAX_COMPONENTS 64U
#define MAX_PATH_BYTES 4095U
#define MAX_EXECUTABLE_BYTES (512ULL * 1024ULL * 1024ULL)
#define HOLD_HEADER_BYTES 104U
#define FRAME_BYTES 16U
#define CMD_GO 2U
#define CMD_CANCEL 3U
#define CMD_TERM 4U
#define CMD_KILL 5U
#define STATUS_VERIFIED 1U
#define STATUS_STARTED 2U
#define STATUS_EXIT 3U
#define STATUS_REFUSED 4U
#define STATUS_UNCERTAIN 5U
#define STATUS_CANCELLED 6U

struct component { int fd; char name[NAME_MAX + 1]; struct stat identity; };
struct held_path { struct component items[MAX_COMPONENTS]; size_t count; int executable; };
static struct held_path program, workspace;
static unsigned char expected_digest[CC_SHA256_DIGEST_LENGTH];
static char executable_path[MAX_PATH_BYTES + 1], workspace_path[MAX_PATH_BYTES + 1];
static uid_t owner;
static uint64_t deadline;
static uint32_t run_ms;
static volatile sig_atomic_t cancelled;
static pid_t child = -1;
/* Private to the native supervisor/custodian pair.  This identifier never
 * crosses the status protocol and is never accepted back as authority. */
static pid_t recovery_group = -1;
static int reaped;
static int group_owned;

/* Supervisor-private descriptors must never alias the six public protocol
 * descriptors, even if a caller entered with one of 0..5 closed.  Keeping
 * them close-on-exec also makes target non-inheritance independent of the
 * spawn implementation's CLOEXEC_DEFAULT support. */
static int private_fd(int *fd) {
  if (*fd <= 5) {
    int moved = fcntl(*fd, F_DUPFD_CLOEXEC, 6);
    if (moved < 0) return -1;
    close(*fd); *fd = moved;
    return 0;
  }
  int flags = fcntl(*fd, F_GETFD);
  return flags >= 0 && fcntl(*fd, F_SETFD, flags | FD_CLOEXEC) == 0 ? 0 : -1;
}

static uint64_t now_ms(void) {
  struct timespec ts;
  if (clock_gettime(CLOCK_MONOTONIC, &ts) != 0) return 0;
  return (uint64_t)ts.tv_sec * 1000U + (uint64_t)ts.tv_nsec / 1000000U;
}
static void cancel(int value) { (void)value; cancelled = 1; }
static uint32_t u32(const unsigned char *p) {
  return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}
static uint64_t u64(const unsigned char *p) { return ((uint64_t)u32(p) << 32) | u32(p + 4); }
static void put32(unsigned char *p, uint32_t value) {
  p[0] = (unsigned char)(value >> 24); p[1] = (unsigned char)(value >> 16);
  p[2] = (unsigned char)(value >> 8); p[3] = (unsigned char)value;
}
static int active(void) { uint64_t now = now_ms(); return !cancelled && now > 0 && now < deadline; }
static int exact_read(unsigned char *bytes, size_t length) {
  size_t offset = 0;
  while (offset < length && active()) {
    struct pollfd p = { .fd = 0, .events = POLLIN, .revents = 0 };
    int ready = poll(&p, 1, 25);
    if (ready < 0 && errno == EINTR) continue;
    if (ready < 0 || (ready > 0 && (p.revents & (POLLERR | POLLNVAL)))) return -1;
    if (ready == 0) continue;
    ssize_t count = read(0, bytes + offset, length - offset);
    if (count < 0 && (errno == EINTR || errno == EAGAIN)) continue;
    if (count <= 0) return -1;
    offset += (size_t)count;
  }
  return offset == length ? 0 : -1;
}
static int status(uint8_t code, uint8_t kind, uint32_t value, uint8_t absent) {
  unsigned char bytes[FRAME_BYTES] = { 'A', 'C', 'R', 'S', code, kind, absent, 0 };
  put32(bytes + 8, value);
  /* A status sink cannot block process cleanup. Every reply fits PIPE_BUF. */
  struct stat sink;
  int flags = fcntl(1, F_GETFL);
  if (fstat(1, &sink) != 0 || (!S_ISFIFO(sink.st_mode) && !S_ISSOCK(sink.st_mode))
      || flags < 0 || fcntl(1, F_SETFL, flags | O_NONBLOCK) != 0) return -1;
  ssize_t count = write(1, bytes, sizeof(bytes));
  return count == (ssize_t)sizeof(bytes) ? 0 : -1;
}
static int same(const struct stat *a, const struct stat *b) {
  return a->st_dev == b->st_dev && a->st_ino == b->st_ino && a->st_uid == b->st_uid
    && a->st_gid == b->st_gid && a->st_mode == b->st_mode && a->st_nlink == b->st_nlink;
}
static int no_acl(int fd) {
  acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (acl == NULL) return errno == ENOENT;
  acl_entry_t entry; int result = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry), saved = errno;
  acl_free(acl); return result == -1 && saved == EINVAL;
}
static int permitted_node(int fd, struct stat *s, int executable, int sticky_tmp) {
  if (fstat(fd, s) != 0 || s->st_dev < 0 || !no_acl(fd)
      || (s->st_uid != owner && s->st_uid != 0) || (s->st_mode & 06000) != 0) return 0;
  if (executable) return S_ISREG(s->st_mode) && s->st_nlink == 1 && (s->st_mode & 0111) != 0
    && (s->st_mode & 0022) == 0 && s->st_size > 0 && (uint64_t)s->st_size <= MAX_EXECUTABLE_BYTES;
  if (!S_ISDIR(s->st_mode)) return 0;
  if (sticky_tmp) return s->st_uid == 0 && (s->st_mode & 07777) == 01777;
  return (s->st_mode & 01022) == 0;
}
static int sticky_component(const struct held_path *path, size_t index) {
  return index == 2 && strcmp(path->items[1].name, "private") == 0
    && strcmp(path->items[2].name, "tmp") == 0;
}
static int open_path(struct held_path *path, const char *text, size_t length, int executable,
    uint64_t device, uint64_t inode) {
  if (length < 2 || length > MAX_PATH_BYTES || text[0] != '/' || text[length - 1] == '/') return -1;
  path->executable = executable;
  path->items[0].fd = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (path->items[0].fd < 0) return -1;
  path->count = 1;
  if (!permitted_node(path->items[0].fd, &path->items[0].identity, 0, 0)) return -1;
  size_t start = 1;
  while (start < length) {
    size_t end = start;
    while (end < length && text[end] != '/') {
      if ((unsigned char)text[end] < 32 || text[end] == 127) return -1;
      end++;
    }
    size_t size = end - start;
    if (path->count >= MAX_COMPONENTS || size == 0 || size > NAME_MAX
        || (size == 1 && text[start] == '.') || (size == 2 && memcmp(text + start, "..", 2) == 0)) return -1;
    size_t index = path->count;
    struct component *item = &path->items[index];
    memcpy(item->name, text + start, size); item->name[size] = '\0';
    int last = end == length, flags = O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK;
    if (!last || !executable) flags |= O_DIRECTORY;
    item->fd = openat(path->items[index - 1].fd, item->name, flags);
    if (item->fd < 0) return -1;
    path->count++;
    if (!permitted_node(item->fd, &item->identity, last && executable, sticky_component(path, index))) return -1;
    start = end + 1;
  }
  const struct stat *s = &path->items[path->count - 1].identity;
  if ((uint64_t)s->st_dev != device || (uint64_t)s->st_ino != inode) return -1;
  /* Workspace custody requires an owner-private directory. */
  if (!executable && (s->st_uid != owner || (s->st_mode & 07777) != 0700)) return -1;
  return 0;
}
static int verify_path(struct held_path *path) {
  if (path->count < 2) return -1;
  int current = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (current < 0) return -1;
  for (size_t i = 0; i < path->count; i++) {
    int executable = i == path->count - 1 && path->executable;
    struct stat held, named;
    if (i > 0) {
      int flags = O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK;
      if (!executable) flags |= O_DIRECTORY;
      int next = openat(current, path->items[i].name, flags);
      close(current); current = next;
    }
    if (current < 0 || !permitted_node(current, &named, executable, sticky_component(path, i))
        || !permitted_node(path->items[i].fd, &held, executable, sticky_component(path, i))
        || !same(&held, &path->items[i].identity) || !same(&held, &named)
        || (executable && (held.st_size != path->items[i].identity.st_size
          || held.st_mtimespec.tv_sec != path->items[i].identity.st_mtimespec.tv_sec
          || held.st_mtimespec.tv_nsec != path->items[i].identity.st_mtimespec.tv_nsec
          || held.st_ctimespec.tv_sec != path->items[i].identity.st_ctimespec.tv_sec
          || held.st_ctimespec.tv_nsec != path->items[i].identity.st_ctimespec.tv_nsec))) {
      if (current >= 0) close(current); return -1;
    }
  }
  close(current); return 0;
}
static int verify_digest(void) {
  const struct component *item = &program.items[program.count - 1];
  struct mach_header_64 header;
  if (pread(item->fd, &header, sizeof(header), 0) != (ssize_t)sizeof(header)
      || header.magic != MH_MAGIC_64 || header.filetype != MH_EXECUTE) return -1;
#if defined(__arm64__)
  if (header.cputype != CPU_TYPE_ARM64) return -1;
#elif defined(__x86_64__)
  if (header.cputype != CPU_TYPE_X86_64) return -1;
#else
#error "Unsupported architecture"
#endif
  CC_SHA256_CTX context; unsigned char bytes[16384], digest[CC_SHA256_DIGEST_LENGTH];
  if (CC_SHA256_Init(&context) != 1) return -1;
  off_t offset = 0;
  while (offset < item->identity.st_size && active()) {
    ssize_t count = pread(item->fd, bytes, sizeof(bytes), offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0 || count > item->identity.st_size - offset
        || CC_SHA256_Update(&context, bytes, (CC_LONG)count) != 1) return -1;
    offset += count;
  }
  return offset == item->identity.st_size && active() && CC_SHA256_Final(digest, &context) == 1
    && memcmp(digest, expected_digest, sizeof(digest)) == 0 && verify_path(&program) == 0 ? 0 : -1;
}
static int guest_matches(void) {
  struct proc_bsdinfo info;
  if (proc_pidinfo(child, PROC_PIDTBSDINFO, 0, &info, sizeof(info)) != (int)sizeof(info)
      || info.pbi_pid != (uint32_t)child || info.pbi_ppid != (uint32_t)getpid()
      || info.pbi_pgid != (uint32_t)recovery_group || info.pbi_status != SSTOP
      || info.pbi_uid != owner || info.pbi_ruid != owner || info.pbi_svuid != owner
      || (info.pbi_flags & PROC_FLAG_TRACED) != 0) return -1;
  struct proc_vnodepathinfo paths;
  const struct stat *cwd = &workspace.items[workspace.count - 1].identity;
  if (proc_pidinfo(child, PROC_PIDVNODEPATHINFO, 0, &paths, sizeof(paths)) != (int)sizeof(paths)
      || paths.pvi_cdir.vip_vi.vi_stat.vst_dev != (uint32_t)cwd->st_dev
      || paths.pvi_cdir.vip_vi.vi_stat.vst_ino != cwd->st_ino) return -1;
  /* Read the kernel's mapped vnode, not stat(proc_pidpath()). A substituted
   * path must never certify a different executable already mapped by exec. */
  const struct stat *image = &program.items[program.count - 1].identity;
  uint64_t address = 0;
  for (size_t i = 0; i < 256; i++) {
    struct proc_regionwithpathinfo region;
    if (proc_pidinfo(child, PROC_PIDREGIONPATHINFO, address, &region, sizeof(region)) != (int)sizeof(region)) return -1;
    if ((region.prp_prinfo.pri_protection & VM_PROT_EXECUTE) != 0 && region.prp_vip.vip_vi.vi_stat.vst_ino != 0)
      return region.prp_vip.vip_vi.vi_stat.vst_dev == (uint32_t)image->st_dev
        && region.prp_vip.vip_vi.vi_stat.vst_ino == image->st_ino ? 0 : -1;
    uint64_t next = region.prp_prinfo.pri_address + region.prp_prinfo.pri_size;
    if (next <= address || next < region.prp_prinfo.pri_address) return -1;
    address = next;
  }
  return -1;
}
static int spawn_suspended(void) {
  posix_spawnattr_t attributes;
  posix_spawn_file_actions_t actions;
  if (posix_spawnattr_init(&attributes) != 0) return -1;
  if (posix_spawn_file_actions_init(&actions) != 0) { posix_spawnattr_destroy(&attributes); return -1; }
  sigset_t mask, defaults; sigemptyset(&mask); sigfillset(&defaults);
  short flags = POSIX_SPAWN_START_SUSPENDED | POSIX_SPAWN_SETPGROUP | POSIX_SPAWN_CLOEXEC_DEFAULT
    | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF;
  int result = posix_spawnattr_setflags(&attributes, flags)
    || recovery_group <= 1 || posix_spawnattr_setpgroup(&attributes, recovery_group)
    || posix_spawnattr_setsigmask(&attributes, &mask)
    || posix_spawnattr_setsigdefault(&attributes, &defaults)
    || posix_spawn_file_actions_adddup2(&actions, 3, 0)
    || posix_spawn_file_actions_adddup2(&actions, 4, 1)
    || posix_spawn_file_actions_adddup2(&actions, 5, 2)
    || posix_spawn_file_actions_addfchdir_np(&actions, workspace.items[workspace.count - 1].fd);
  char *args[] = { executable_path, "--print", "--output-format", "stream-json", "--verbose",
    "--restricted", "--bare", "--disallowedTools", "*,mcp__*", "--permission-prompts", "none",
    "--no-session-persistence", "--max-turns", "1", "--model", "opus", NULL };
  char *environment[] = { "PATH=/usr/bin:/bin", "LANG=C", "LC_ALL=C", NULL };
  if (!result) result = posix_spawn(&child, executable_path, &actions, &attributes, args, environment);
  posix_spawn_file_actions_destroy(&actions); posix_spawnattr_destroy(&attributes);
  if (result != 0 || child <= 0) return -1;
  struct proc_bsdinfo identity;
  group_owned = proc_pidinfo(child, PROC_PIDTBSDINFO, 0, &identity, sizeof(identity)) == (int)sizeof(identity)
    && identity.pbi_ppid == (uint32_t)getpid() && identity.pbi_pgid == (uint32_t)recovery_group;
  return group_owned ? 0 : -1;
}
static int await_suspended_identity(void) {
  /* Kernel inspection can briefly lag posix_spawn's return. START_SUSPENDED
   * stays in force throughout this bounded observation; only an exact match
   * can allow the caller to continue. */
  uint64_t until = now_ms() + 500U;
  while (active() && now_ms() < until) {
    if (guest_matches() == 0) return 0;
    poll(NULL, 0, 5);
  }
  return -1;
}
static int leader_finished(void) {
  siginfo_t value; memset(&value, 0, sizeof(value));
  if (waitid(P_PID, (id_t)child, &value, WEXITED | WNOHANG | WNOWAIT) != 0) return -1;
  return value.si_pid == child ? 1 : 0;
}
static int group_signal(int number) {
  /* Never signal a numeric group again once its leader has been reaped. */
  if (child <= 0 || recovery_group <= 1 || reaped || !group_owned) return -1;
  return kill(-recovery_group, number) == 0 || errno == ESRCH ? 0 : -1;
}
static int retire(int *exit_status) {
  if (child <= 0 || reaped) return -1;
  uint64_t until = now_ms() + 3000U;
  /* Darwin may refuse a signal when only a zombie remains. A refused signal
   * is not proof of cleanup; keep reaping, then require actual group absence. */
  (void)group_signal(SIGKILL);
  /* Kill the owned leader separately too if group creation was not verified. */
  (void)kill(child, SIGKILL);
  while (now_ms() < until) {
    pid_t result = waitpid(child, exit_status, WNOHANG);
    if (result == child) { reaped = 1; break; }
    if (result < 0 && errno != EINTR) return -1;
    poll(NULL, 0, 10);
  }
  if (!reaped || !group_owned) return -1;
  /* No more signals after reaping; PID/group reuse can only cause uncertainty. */
  while (now_ms() < until) {
    if (kill(-recovery_group, 0) != 0 && errno == ESRCH) return 0;
    poll(NULL, 0, 10);
  }
  return -1;
}
static int command(void) {
  unsigned char frame[FRAME_BYTES];
  if (exact_read(frame, sizeof(frame)) != 0 || memcmp(frame, "ACRC", 4) != 0) return -1;
  for (size_t i = 5; i < sizeof(frame); i++) if (frame[i] != 0) return -1;
  return frame[4];
}
static void close_paths(void) {
  for (size_t i = 0; i < program.count; i++) close(program.items[i].fd);
  for (size_t i = 0; i < workspace.count; i++) close(workspace.items[i].fd);
}
static int __attribute__((unused)) custodian_main(int argc, char **argv, pid_t owned_group) {
  (void)argv;
  int outcome = 1, exit_status = 0, resumed = 0;
  recovery_group = owned_group;
  signal(SIGPIPE, SIG_IGN); signal(SIGTERM, cancel); signal(SIGINT, cancel); signal(SIGHUP, cancel);
  owner = geteuid(); deadline = now_ms() + 30000U;
  if (argc != 1 || owner == 0 || getuid() != owner || getgid() != getegid()) goto done;
  for (int fd = 0; fd <= 5; fd++) {
    struct stat s;
    if (fstat(fd, &s) != 0 || (!S_ISFIFO(s.st_mode) && !S_ISSOCK(s.st_mode))) goto done;
  }
  unsigned char header[HOLD_HEADER_BYTES];
  if (exact_read(header, sizeof(header)) != 0 || memcmp(header, "ACRCCP1\n", 8) != 0
      || u32(header + 8) != 1 || u32(header + 28) != 0 || u64(header + 32) != owner) goto done;
  uint32_t exec_length = u32(header + 12), cwd_length = u32(header + 16), hold_ms = u32(header + 20);
  run_ms = u32(header + 24);
  if (exec_length < 2 || exec_length > MAX_PATH_BYTES || cwd_length < 2 || cwd_length > MAX_PATH_BYTES
      || hold_ms < 100 || hold_ms > 30000 || run_ms < 100 || run_ms > 600000) goto done;
  deadline = now_ms() + hold_ms;
  memcpy(expected_digest, header + 72, sizeof(expected_digest));
  if (exact_read((unsigned char *)executable_path, exec_length) != 0
      || exact_read((unsigned char *)workspace_path, cwd_length) != 0
      || open_path(&program, executable_path, exec_length, 1, u64(header + 40), u64(header + 48)) != 0
      || open_path(&workspace, workspace_path, cwd_length, 0, u64(header + 56), u64(header + 64)) != 0
      || verify_path(&program) != 0 || verify_path(&workspace) != 0 || verify_digest() != 0
      || status(STATUS_VERIFIED, 0, 0, 0) != 0) goto done;
  int selected = command();
  if (selected == CMD_CANCEL) { outcome = status(STATUS_CANCELLED, 0, 0, 0) == 0 ? 0 : 1; goto close; }
  if (selected != CMD_GO || !active() || verify_path(&program) != 0 || verify_path(&workspace) != 0
      || verify_digest() != 0 || spawn_suspended() != 0) goto done;
  if (!active() || await_suspended_identity() != 0 || verify_path(&program) != 0 || verify_path(&workspace) != 0
      || verify_digest() != 0 || guest_matches() != 0 || !active()) goto done;
  if (kill(child, SIGCONT) != 0) goto done;
  resumed = 1; deadline = now_ms() + run_ms;
  if (status(STATUS_STARTED, 0, 0, 0) != 0) goto done;
  close(3); close(4); close(5);
  unsigned commands = 0;
  while (active()) {
    int finished = leader_finished();
    if (finished < 0) goto done;
    if (finished) {
      if (retire(&exit_status) != 0) goto done;
      if (WIFEXITED(exit_status)) outcome = status(STATUS_EXIT, 1, (uint32_t)WEXITSTATUS(exit_status), 1) == 0 ? 0 : 1;
      else if (WIFSIGNALED(exit_status)) outcome = status(STATUS_EXIT, 2, (uint32_t)WTERMSIG(exit_status), 1) == 0 ? 0 : 1;
      goto close;
    }
    struct pollfd p = { .fd = 0, .events = POLLIN, .revents = 0 };
    int ready = poll(&p, 1, 25);
    if (ready < 0 && errno == EINTR) continue;
    if (ready < 0) goto done;
    if (!ready) continue;
    if (++commands > 32) goto done;
    selected = command();
    if (selected == CMD_TERM) { if (group_signal(SIGTERM) != 0) goto done; }
    else if (selected == CMD_KILL || selected == CMD_CANCEL) { if (group_signal(SIGKILL) != 0) goto done; }
    else goto done;
  }
done:
  if (child > 0 && !reaped) {
    int certain = retire(&exit_status) == 0;
    status(certain && !resumed ? STATUS_REFUSED : STATUS_UNCERTAIN, 0, 0, 0);
  } else status(resumed ? STATUS_UNCERTAIN : STATUS_REFUSED, 0, 0, 0);
close:
  close_paths(); return outcome;
}

/*
 * A separate parent owns an otherwise empty process-group anchor before the
 * custodian can read HOLD or create a target.  The target joins that anchored
 * group while suspended.  If the custodian disappears, the supervisor still
 * owns a non-reusable group identity long enough to kill it and prove absence.
 * Neither the anchor pid nor the target pid is emitted on the public protocol.
 */
static int supervise(int argc, char **argv) {
  int ready[2] = { -1, -1 };
  int watch[2] = { -1, -1 };
  if (pipe(ready) != 0 || private_fd(&ready[0]) != 0 || private_fd(&ready[1]) != 0
      || pipe(watch) != 0 || private_fd(&watch[0]) != 0 || private_fd(&watch[1]) != 0) {
    if (ready[0] >= 0) close(ready[0]); if (ready[1] >= 0) close(ready[1]);
    if (watch[0] >= 0) close(watch[0]); if (watch[1] >= 0) close(watch[1]);
    return 2;
  }
  pid_t anchor = fork();
  if (anchor < 0) { close(ready[0]); close(ready[1]); close(watch[0]); close(watch[1]); return 2; }
  if (anchor == 0) {
    close(ready[0]); close(watch[1]);
    for (int fd = 0; fd <= 5; fd++) close(fd);
    if (setpgid(0, 0) != 0) _exit(111);
    unsigned char value = 1;
    if (write(ready[1], &value, 1) != 1) _exit(112);
    close(ready[1]);
    /* The custodian owns the only writer after its fork. EOF therefore means
     * it is gone even if the outer supervisor also died. The anchor kills its
     * own group, including itself and every target member. */
    for (;;) {
      unsigned char ignored;
      ssize_t count = read(watch[0], &ignored, 1);
      if (count < 0 && errno == EINTR) continue;
      if (count == 0) { (void)kill(-getpid(), SIGKILL); _exit(114); }
      if (count < 0) _exit(115);
    }
  }
  close(ready[1]); close(watch[0]);
  unsigned char value = 0;
  if (read(ready[0], &value, 1) != 1 || value != 1) {
    close(ready[0]); close(watch[1]); (void)kill(anchor, SIGKILL); (void)waitpid(anchor, NULL, 0); return 2;
  }
  close(ready[0]);
  pid_t custodian = fork();
  if (custodian < 0) { close(watch[1]); (void)kill(-anchor, SIGKILL); (void)waitpid(anchor, NULL, 0); return 2; }
  if (custodian == 0) {
    /* Keep the watchdog writer for this process lifetime; it is never exposed
     * to the target because CLOEXEC_DEFAULT closes it at target exec. */
#ifdef ACR_TEST_CUSTODIAN_DEATH_BEFORE_HOLD
    (void)argc; (void)argv; (void)kill(getpid(), SIGKILL); _exit(113);
#else
    _exit(custodian_main(argc, argv, anchor));
#endif
  }
  close(watch[1]);
  /* Only the custodian may retain protocol and target streams. */
  for (int fd = 0; fd <= 5; fd++) close(fd);
  int custodian_status = 0, anchor_status = 0;
  int custodian_done = 0, anchor_done = 0;
  uint64_t until = now_ms() + 640000U;
  while (!custodian_done && now_ms() > 0 && now_ms() < until) {
    pid_t observed = waitpid(custodian, &custodian_status, WNOHANG);
    if (observed == custodian) custodian_done = 1;
    else if (observed < 0 && errno != EINTR) break;
    if (!anchor_done) {
      observed = waitpid(anchor, &anchor_status, WNOHANG);
      if (observed == anchor) anchor_done = 1;
      else if (observed < 0 && errno != EINTR) break;
    }
    if (!custodian_done) poll(NULL, 0, 10);
  }
  /* Cleanup is unconditional.  On the normal path the custodian already did
   * this; after abrupt death this is the independent recovery action. */
  if (!custodian_done) (void)kill(custodian, SIGKILL);
  /* Never signal this numeric group after its anchor has been reaped: a
   * later PID/PGID reuse must be treated as uncertainty, not authority. */
  if (!anchor_done) (void)kill(-anchor, SIGKILL);
  uint64_t cleanup_until = now_ms() + 3000U;
  while ((!custodian_done || !anchor_done) && now_ms() > 0 && now_ms() < cleanup_until) {
    if (!custodian_done) {
      pid_t observed = waitpid(custodian, &custodian_status, WNOHANG);
      if (observed == custodian) custodian_done = 1;
      else if (observed < 0 && errno != EINTR) break;
    }
    if (!anchor_done) {
      pid_t observed = waitpid(anchor, &anchor_status, WNOHANG);
      if (observed == anchor) anchor_done = 1;
      else if (observed < 0 && errno != EINTR) break;
    }
    if (!custodian_done || !anchor_done) poll(NULL, 0, 10);
  }
  int absent = 0;
  if (custodian_done && anchor_done) {
    while (now_ms() > 0 && now_ms() < cleanup_until) {
      if (kill(-anchor, 0) != 0 && errno == ESRCH) { absent = 1; break; }
      poll(NULL, 0, 10);
    }
  }
  if (!absent || !custodian_done || !anchor_done) return 2;
  if (WIFEXITED(custodian_status)
      && (WEXITSTATUS(custodian_status) == 0 || WEXITSTATUS(custodian_status) == 1))
    return WEXITSTATUS(custodian_status);
  /* Exact exit 2 means cleanup was independently confirmed after custodian
   * loss.  It is not a task result and never grants replay or resume. */
  return 2;
}

int main(int argc, char **argv) { return supervise(argc, argv); }
