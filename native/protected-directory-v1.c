/* Control Room's one-shot macOS directory primitive. No shell, repair or retry.
 * The caller owns the operation/owner-attendance/journal boundary. All input is
 * private pipe data; stdout is a bounded path-free protocol and stderr is unused.
 * OS trust boundary: root and other processes running as this owner are trusted.
 * The held parent prevents path replacement from redirecting mkdirat; the
 * multi-syscall transaction is not atomic against malicious same-UID writers.
 */
#ifndef __APPLE__
#error "protected-directory-v1 requires the reviewed macOS ACL implementation"
#endif
#include <sys/acl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define SAFE_INTEGER UINT64_C(9007199254740991)
#define MAX_PARENT 4096U
#define MAX_CHILD 255U
#define HEADER_BYTES 48U
#ifndef ACR_TEST_CHECKPOINT
#define ACR_TEST_CHECKPOINT(phase, parent, child) ((void)0)
#endif

static volatile sig_atomic_t cancelled = 0;
static uint64_t deadline = 0;
static void cancel_operation(int signal_number) { (void)signal_number; cancelled = 1; }
static uint64_t now_ms(clockid_t clock_id) {
  struct timespec value;
  if (clock_gettime(clock_id, &value) != 0 || value.tv_sec < 0) return 0;
  return (uint64_t)value.tv_sec * 1000U + (uint64_t)value.tv_nsec / 1000000U;
}
static int active(void) {
  uint64_t now = now_ms(CLOCK_MONOTONIC);
  return !cancelled && now != 0 && now < deadline;
}
static int read_exact(unsigned char *bytes, size_t count) {
  while (count != 0 && active()) {
    uint64_t now = now_ms(CLOCK_MONOTONIC);
    if (now == 0 || now >= deadline) return -1;
    struct pollfd input = { .fd = STDIN_FILENO, .events = POLLIN, .revents = 0 };
    int result = poll(&input, 1, (int)(deadline - now));
    if (result <= 0) return -1;
    ssize_t received = read(STDIN_FILENO, bytes, count);
    if (received <= 0) return -1;
    bytes += (size_t)received;
    count -= (size_t)received;
  }
  return count == 0 && active() ? 0 : -1;
}
static uint64_t decode_u64(const unsigned char *bytes) {
  uint64_t value = 0;
  for (size_t index = 0; index < 8; index++) value = (value << 8) | bytes[index];
  return value;
}
static uint32_t decode_u32(const unsigned char *bytes) {
  uint32_t value = 0;
  for (size_t index = 0; index < 4; index++) value = (value << 8) | bytes[index];
  return value;
}
static int basename_valid(const char *bytes, size_t count) {
  if (count == 0 || count > MAX_CHILD || (count == 1 && bytes[0] == '.')
      || (count == 2 && bytes[0] == '.' && bytes[1] == '.')) return 0;
  for (size_t index = 0; index < count; index++) {
    unsigned char value = (unsigned char)bytes[index];
    if (value < 32 || value == 127 || value == '/') return 0;
  }
  return 1;
}
/* Stricter than a mode-bit test: no extended ACL entries, including inherited
 * entries. Do not edit ACLs to make an existing directory acceptable. */
static int no_extended_acl(int fd) {
  acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  /* Darwin reports ENOENT when this opened object has no extended ACL. */
  if (acl == NULL) return errno == ENOENT;
  acl_entry_t entry;
  int result = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry);
  int saved_errno = errno;
  acl_free(acl);
  return result == -1 && saved_errno == EINVAL;
}
static int safe_stat_identity(const struct stat *value) {
  return value->st_dev >= 0 && (uint64_t)value->st_dev <= SAFE_INTEGER
    && (uint64_t)value->st_ino <= SAFE_INTEGER;
}
static int same_identity(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino;
}
static int private_directory(int fd, struct stat *value, uint64_t uid) {
  return fstat(fd, value) == 0 && S_ISDIR(value->st_mode)
    && safe_stat_identity(value) && (uint64_t)value->st_uid == uid
    && (value->st_mode & 07777) == 0700 && no_extended_acl(fd);
}
static int open_parent(const char *path, size_t length) {
  if (length < 2 || length > MAX_PARENT || path[0] != '/' || path[length - 1] == '/') return -1;
  int fd = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return -1;
  size_t start = 1;
  while (start < length && active()) {
    size_t end = start;
    while (end < length && path[end] != '/') end++;
    if (!basename_valid(path + start, end - start)) { close(fd); return -1; }
    char component[MAX_CHILD + 1];
    memcpy(component, path + start, end - start);
    component[end - start] = '\0';
    int next = openat(fd, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    close(fd);
    if (next < 0) return -1;
    fd = next;
    start = end + 1;
  }
  if (!active()) { close(fd); return -1; }
  return fd;
}

int main(int argc, char **argv) {
  (void)argv;
  int parent_fd = -1, child_fd = -1, current_fd = -1, outcome = 1;
  unsigned char header[HEADER_BYTES];
  char parent[MAX_PARENT + 1], child[MAX_CHILD + 1];
  struct stat parent_before, parent_after, child_at, child_opened, current_parent;
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = cancel_operation;
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGTERM, &action, NULL) != 0 || sigaction(SIGINT, &action, NULL) != 0
      || signal(SIGPIPE, SIG_IGN) == SIG_ERR) return 1;
  uint64_t started = now_ms(CLOCK_MONOTONIC);
  if (started == 0) return 1;
  deadline = started + 30000U;
  if (argc != 1 || getuid() != geteuid() || getgid() != getegid() || geteuid() == 0
      || read_exact(header, sizeof(header)) != 0 || memcmp(header, "ACRDIR1\n", 8) != 0) goto done;
  uint32_t parent_length = decode_u32(header + 8), child_length = decode_u32(header + 12);
  uint64_t device = decode_u64(header + 16), inode = decode_u64(header + 24);
  uint64_t uid = decode_u64(header + 32), wall_deadline = decode_u64(header + 40);
  uint64_t wall_now = now_ms(CLOCK_REALTIME), mono_now = now_ms(CLOCK_MONOTONIC);
  if (parent_length < 2 || parent_length > MAX_PARENT || child_length == 0 || child_length > MAX_CHILD
      || device > SAFE_INTEGER || inode > SAFE_INTEGER || uid > INT32_MAX || uid != geteuid()
      || wall_deadline > SAFE_INTEGER || wall_now == 0 || mono_now == 0 || wall_deadline <= wall_now
      || wall_deadline - wall_now > 30000U) goto done;
  uint64_t requested_deadline = mono_now + wall_deadline - wall_now;
  if (requested_deadline < deadline) deadline = requested_deadline;
  if (read_exact((unsigned char *)parent, parent_length) != 0
      || read_exact((unsigned char *)child, child_length) != 0) goto done;
  parent[parent_length] = '\0'; child[child_length] = '\0';
  /* Require EOF after the one frame. No second request or trailing material. */
  struct pollfd input = { .fd = STDIN_FILENO, .events = POLLIN, .revents = 0 };
  if (!active()) goto done;
  uint64_t before_eof = now_ms(CLOCK_MONOTONIC);
  if (before_eof == 0 || before_eof >= deadline
      || poll(&input, 1, (int)(deadline - before_eof)) <= 0) goto done;
  unsigned char extra;
  if (read(STDIN_FILENO, &extra, 1) != 0 || !basename_valid(child, child_length)) goto done;
  parent_fd = open_parent(parent, parent_length);
  if (parent_fd < 0 || !private_directory(parent_fd, &parent_before, uid)
      || (uint64_t)parent_before.st_dev != device || (uint64_t)parent_before.st_ino != inode) goto done;
  ACR_TEST_CHECKPOINT(1, parent_fd, child);
  if (!active()) goto done;
  umask(077);
  /* Exactly one effect attempt; neither EINTR nor EEXIST causes a retry. */
  if (mkdirat(parent_fd, child, 0700) != 0) goto done;
  ACR_TEST_CHECKPOINT(2, parent_fd, child);
  if (!active() || fstatat(parent_fd, child, &child_at, AT_SYMLINK_NOFOLLOW) != 0
      || !S_ISDIR(child_at.st_mode) || !safe_stat_identity(&child_at)
      || child_at.st_uid != uid || (child_at.st_mode & 07777) != 0700) goto done;
  child_fd = openat(parent_fd, child, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (child_fd < 0 || !private_directory(child_fd, &child_opened, uid)
      || !same_identity(&child_at, &child_opened)
      || !private_directory(parent_fd, &parent_after, uid)
      || !same_identity(&parent_before, &parent_after)) goto done;
  /* Detect parent rename/substitution before reporting. Creation itself always
   * remained anchored to parent_fd. The owner runner repeats its path checks. */
  current_fd = open_parent(parent, parent_length);
  if (current_fd < 0 || !private_directory(current_fd, &current_parent, uid)
      || !same_identity(&parent_before, &current_parent)
      || fstatat(parent_fd, child, &child_at, AT_SYMLINK_NOFOLLOW) != 0
      || !same_identity(&child_at, &child_opened) || !S_ISDIR(child_at.st_mode)
      || !private_directory(child_fd, &child_at, uid) || !active()) goto done;
  ACR_TEST_CHECKPOINT(3, parent_fd, child);
  if (!active()) goto done;
  char response[160];
  int length = snprintf(response, sizeof(response), "ACRDIR1 %" PRIu64 " %" PRIu64 " %" PRIu64 " %" PRIu64 " %" PRIu64 "\n",
    device, inode, (uint64_t)child_opened.st_dev, (uint64_t)child_opened.st_ino, uid);
  if (length < 1 || (size_t)length >= sizeof(response)) goto done;
  /* One small pipe write. A lost/partial reply is uncertainty at the caller. */
  if (write(STDOUT_FILENO, response, (size_t)length) == length) outcome = 0;
done:
  if (current_fd >= 0) close(current_fd);
  if (child_fd >= 0) close(child_fd);
  if (parent_fd >= 0) close(parent_fd);
  return outcome;
}
