/*
 * ACRSVC1: one-shot macOS LaunchAgent publication and launchctl custodian.
 * The protocol has no command string, PATH lookup, environment input, generic
 * target, credential, network, database, repair, delete, or retry capability.
 * Production accepts only the current owner's exact
 * /Users/<owner>/Library/LaunchAgents/xyz.agentcontrolroom.local.plist target.
 */
#ifndef __APPLE__
#error "ACRSVC1 requires macOS"
#endif
#define _DARWIN_C_SOURCE
#define CC_DISABLE_DEPRECATION
#include <CommonCrypto/CommonDigest.h>
#include <sys/acl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define HEADER_BYTES 120U
#define RESPONSE_BYTES 96U
#define MAX_PATH_BYTES 4095U
#define MAX_DEFINITION_BYTES (256U * 1024U)
#define MAX_LAUNCHCTL_OUTPUT (64U * 1024U)
#define SAFE_INTEGER UINT64_C(9007199254740991)
#define OP_VERIFY_PARENT 1U
#define OP_VERIFY_DEFINITION 2U
#define OP_INSTALL 3U
#define OP_STATUS 4U
#define OP_START 5U
#define OP_STOP 6U
#define OUTCOME_SUCCEEDED 1U
#define OUTCOME_FAILED_BEFORE_EFFECT 2U
#define STATE_NOT_INSTALLED 1U
#define STATE_STOPPED 2U
#define STATE_RUNNING 3U
#define STATE_UNKNOWN 4U
#define LABEL "xyz.agentcontrolroom.local"
#define DEFINITION_NAME LABEL ".plist"
#ifndef ACR_LAUNCHCTL_PATH
#define ACR_LAUNCHCTL_PATH "/bin/launchctl"
#endif

extern char **environ;
static volatile sig_atomic_t cancelled;
static uint64_t deadline;
static uint64_t retirement_deadline;
static pid_t child = -1;
static int child_owned;

struct definition_identity {
  int present;
  struct stat stat;
  unsigned char sha256[CC_SHA256_DIGEST_LENGTH];
};

static void cancel_operation(int value) { (void)value; cancelled = 1; }
static uint64_t now_ms(clockid_t clock_id) {
  struct timespec value;
  if (clock_gettime(clock_id, &value) != 0 || value.tv_sec < 0) return 0;
  return (uint64_t)value.tv_sec * 1000U + (uint64_t)value.tv_nsec / 1000000U;
}
static int active(void) {
  uint64_t now = now_ms(CLOCK_MONOTONIC);
  return !cancelled && now != 0 && now < deadline;
}
static uint32_t u32(const unsigned char *p) {
  return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}
static uint64_t u64(const unsigned char *p) { return ((uint64_t)u32(p) << 32) | u32(p + 4); }
static void put32(unsigned char *p, uint32_t value) {
  p[0] = (unsigned char)(value >> 24); p[1] = (unsigned char)(value >> 16);
  p[2] = (unsigned char)(value >> 8); p[3] = (unsigned char)value;
}
static void put64(unsigned char *p, uint64_t value) { put32(p, (uint32_t)(value >> 32)); put32(p + 4, (uint32_t)value); }
static int exact_read(unsigned char *bytes, size_t length) {
  size_t offset = 0;
  while (offset < length && active()) {
    struct pollfd p = { .fd = STDIN_FILENO, .events = POLLIN, .revents = 0 };
    int ready = poll(&p, 1, 25);
    if (ready < 0 && errno == EINTR) continue;
    if (ready < 0 || (ready > 0 && (p.revents & (POLLERR | POLLNVAL)))) return -1;
    if (ready == 0) continue;
    ssize_t count = read(STDIN_FILENO, bytes + offset, length - offset);
    if (count < 0 && (errno == EINTR || errno == EAGAIN)) continue;
    if (count <= 0) return -1;
    offset += (size_t)count;
  }
  return offset == length ? 0 : -1;
}
static int require_eof(void) {
  unsigned char byte;
  while (active()) {
    ssize_t count = read(STDIN_FILENO, &byte, 1);
    if (count == 0) return 0;
    if (count < 0 && errno == EINTR) continue;
    if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) {
      struct pollfd p = { .fd = STDIN_FILENO, .events = POLLIN | POLLHUP, .revents = 0 };
      if (poll(&p, 1, 25) < 0 && errno != EINTR) return -1;
      continue;
    }
    return -1;
  }
  return -1;
}
static int no_acl(int fd) {
  acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (acl == NULL) return errno == ENOENT;
  acl_entry_t entry;
  int result = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry), saved = errno;
  acl_free(acl);
  return result == -1 && saved == EINVAL;
}
static int harmless_ancestor_acl(int fd) {
  static const unsigned char everyone[16] = {
    0xab, 0xcd, 0xef, 0xab, 0xcd, 0xef, 0xab, 0xcd,
    0xef, 0xab, 0xcd, 0xef, 0x00, 0x00, 0x00, 0x0c,
  };
  acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (acl == NULL) return errno == ENOENT;
  acl_entry_t entry;
  int found = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry);
  if (found == -1 && errno == EINVAL) { acl_free(acl); return 1; }
  int valid = found == 0;
  acl_tag_t tag; acl_permset_mask_t permissions = 0; acl_flagset_t flags;
  void *qualifier = NULL;
  if (valid) {
    qualifier = acl_get_qualifier(entry);
    valid = qualifier != NULL && memcmp(qualifier, everyone, sizeof(everyone)) == 0
      && acl_get_tag_type(entry, &tag) == 0 && tag == ACL_EXTENDED_DENY
      && acl_get_permset_mask_np(entry, &permissions) == 0 && permissions == (acl_permset_mask_t)ACL_DELETE
      && acl_get_flagset_np(entry, &flags) == 0
      && acl_get_flag_np(flags, ACL_ENTRY_INHERITED) == 0
      && acl_get_flag_np(flags, ACL_ENTRY_FILE_INHERIT) == 0
      && acl_get_flag_np(flags, ACL_ENTRY_DIRECTORY_INHERIT) == 0
      && acl_get_flag_np(flags, ACL_ENTRY_LIMIT_INHERIT) == 0
      && acl_get_flag_np(flags, ACL_ENTRY_ONLY_INHERIT) == 0;
  }
  if (qualifier != NULL) acl_free(qualifier);
  if (valid) {
    found = acl_get_entry(acl, ACL_NEXT_ENTRY, &entry);
    valid = found == -1 && errno == EINVAL;
  }
  acl_free(acl);
  return valid;
}
static int safe_identity(const struct stat *value) {
  return value->st_dev >= 0 && (uint64_t)value->st_dev <= SAFE_INTEGER
    && (uint64_t)value->st_ino <= SAFE_INTEGER;
}
static int same(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino
    && left->st_uid == right->st_uid && left->st_gid == right->st_gid
    && left->st_mode == right->st_mode && left->st_nlink == right->st_nlink;
}
static int same_directory(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino
    && left->st_uid == right->st_uid && left->st_gid == right->st_gid && left->st_mode == right->st_mode;
}
static int component_valid(const char *value, size_t length) {
  if (length == 0 || length > NAME_MAX || (length == 1 && value[0] == '.')
      || (length == 2 && value[0] == '.' && value[1] == '.')) return 0;
  for (size_t index = 0; index < length; index++) {
    unsigned char byte = (unsigned char)value[index];
    if (byte < 32 || byte == 127 || byte == '/') return 0;
  }
  return 1;
}
static int target_valid(const char *path, size_t length) {
  static const char suffix[] = "/Library/LaunchAgents/" DEFINITION_NAME;
  size_t suffix_length = sizeof(suffix) - 1;
  if (length <= suffix_length + 1 || length > MAX_PATH_BYTES
      || memcmp(path + length - suffix_length, suffix, suffix_length) != 0) return 0;
#ifdef ACR_TEST_MODE
  return path[0] == '/';
#else
  static const char prefix[] = "/Users/";
  size_t prefix_length = sizeof(prefix) - 1;
  if (length <= prefix_length + suffix_length || memcmp(path, prefix, prefix_length) != 0) return 0;
  size_t owner_length = length - prefix_length - suffix_length;
  return component_valid(path + prefix_length, owner_length);
#endif
}
#ifdef ACR_TEST_TARGET_PATH
static int map_test_target(char *path, uint32_t *length) {
  static const char requested[] = "/Users/acr-native-host-fixture/Library/LaunchAgents/" DEFINITION_NAME;
  static const char mapped[] = ACR_TEST_TARGET_PATH;
  size_t requested_length = sizeof(requested) - 1U, mapped_length = sizeof(mapped) - 1U;
  if (*length != requested_length || memcmp(path, requested, requested_length) != 0) return 0;
  if (mapped_length > MAX_PATH_BYTES) return -1;
  memcpy(path, mapped, mapped_length); path[mapped_length] = '\0'; *length = (uint32_t)mapped_length;
  return 0;
}
#endif
static int permitted_directory(int fd, struct stat *value, uid_t owner, int final_parent) {
  if (fstat(fd, value) != 0 || !S_ISDIR(value->st_mode) || !safe_identity(value)
      || (final_parent ? !no_acl(fd) : !harmless_ancestor_acl(fd))
      || (value->st_uid != 0 && value->st_uid != owner) || (value->st_mode & 06000) != 0) return 0;
#ifdef ACR_TEST_MODE
  if ((value->st_mode & 07777) == 01777 && value->st_uid == 0) return !final_parent;
#endif
  if ((value->st_mode & 0022) != 0) return 0;
  return !final_parent || value->st_uid == owner;
}
static int open_parent(const char *path, size_t length, uid_t owner, struct stat *identity) {
  if (!target_valid(path, length)) return -1;
  size_t parent_length = length - (sizeof(DEFINITION_NAME) - 1U);
  if (parent_length < 2 || path[parent_length - 1] != '/') return -1;
  parent_length--;
  int fd = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return -1;
  size_t start = 1;
  while (start < parent_length) {
    size_t end = start;
    while (end < parent_length && path[end] != '/') end++;
    if (!component_valid(path + start, end - start)) { close(fd); return -1; }
    char name[NAME_MAX + 1]; memcpy(name, path + start, end - start); name[end - start] = '\0';
    int next = openat(fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    close(fd); fd = next;
    if (fd < 0) return -1;
    struct stat observed;
    if (!permitted_directory(fd, &observed, owner, end == parent_length)) { close(fd); return -1; }
    start = end + 1;
  }
  if (!permitted_directory(fd, identity, owner, 1)) { close(fd); return -1; }
  return fd;
}
static int hash_fd(int fd, off_t length, unsigned char digest[CC_SHA256_DIGEST_LENGTH]) {
  CC_SHA256_CTX context; unsigned char bytes[16384]; off_t offset = 0;
  if (CC_SHA256_Init(&context) != 1) return -1;
  while (offset < length && active()) {
    size_t wanted = (uint64_t)(length - offset) < sizeof(bytes) ? (size_t)(length - offset) : sizeof(bytes);
    ssize_t count = pread(fd, bytes, wanted, offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0 || CC_SHA256_Update(&context, bytes, (CC_LONG)count) != 1) return -1;
    offset += count;
  }
  return offset == length && active() && CC_SHA256_Final(digest, &context) == 1 ? 0 : -1;
}
static int inspect_definition(int parent, uid_t owner, struct definition_identity *value) {
  memset(value, 0, sizeof(*value));
  struct stat named;
  if (fstatat(parent, DEFINITION_NAME, &named, AT_SYMLINK_NOFOLLOW) != 0) return errno == ENOENT ? 0 : -1;
  if (!S_ISREG(named.st_mode) || !safe_identity(&named) || named.st_uid != owner || named.st_nlink != 1
      || (named.st_mode & 07777) != 0600 || named.st_size < 1 || named.st_size > MAX_DEFINITION_BYTES) return -1;
  int fd = openat(parent, DEFINITION_NAME, O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
  struct stat opened;
  if (fd < 0 || fstat(fd, &opened) != 0 || !same(&named, &opened) || !no_acl(fd)
      || hash_fd(fd, opened.st_size, value->sha256) != 0) { if (fd >= 0) close(fd); return -1; }
  struct stat after;
  int valid = fstat(fd, &after) == 0 && same(&opened, &after)
    && fstatat(parent, DEFINITION_NAME, &named, AT_SYMLINK_NOFOLLOW) == 0 && same(&opened, &named);
  close(fd);
  if (!valid) return -1;
  value->present = 1; value->stat = opened; return 0;
}
static int matches_expected(const struct definition_identity *value, int present, uint64_t device,
    uint64_t inode, uint64_t size, const unsigned char sha256[CC_SHA256_DIGEST_LENGTH]) {
  if (value->present != present) return 0;
  if (!present) return 1;
  return (uint64_t)value->stat.st_dev == device && (uint64_t)value->stat.st_ino == inode
    && (uint64_t)value->stat.st_size == size && memcmp(value->sha256, sha256, CC_SHA256_DIGEST_LENGTH) == 0;
}
static int recheck_parent(const char *path, size_t length, uid_t owner, const struct stat *held) {
  struct stat current; int fd = open_parent(path, length, owner, &current);
  int valid = fd >= 0 && same_directory(held, &current);
  if (fd >= 0) close(fd);
  return valid ? 0 : -1;
}
static int publish_definition(int parent, const struct stat *parent_identity, const char *path, size_t path_length,
    uid_t owner, const unsigned char *bytes, size_t length, struct definition_identity *published) {
  char temporary[96];
  int count = snprintf(temporary, sizeof(temporary), ".%s.%ld.tmp", DEFINITION_NAME, (long)getpid());
  if (count < 1 || (size_t)count >= sizeof(temporary)) return -1;
  struct stat unexpected;
  if (fstatat(parent, temporary, &unexpected, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) return -1;
  int fd = openat(parent, temporary, O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC | O_RDWR | O_NONBLOCK, 0600);
  int renamed = 0, result = -1;
  if (fd < 0) return -1;
  size_t offset = 0;
  while (offset < length && active()) {
    ssize_t written = write(fd, bytes + offset, length - offset);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) goto done;
    offset += (size_t)written;
  }
  struct stat created; unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  if (offset != length || !active() || fchmod(fd, 0600) != 0 || fsync(fd) != 0 || fstat(fd, &created) != 0
      || !S_ISREG(created.st_mode) || created.st_uid != owner || created.st_nlink != 1
      || (created.st_mode & 07777) != 0600 || created.st_size != (off_t)length || !no_acl(fd)
      || hash_fd(fd, created.st_size, digest) != 0 || recheck_parent(path, path_length, owner, parent_identity) != 0) goto done;
  if (renameatx_np(parent, temporary, parent, DEFINITION_NAME, RENAME_EXCL) != 0) goto done;
  renamed = 1;
  if (fsync(parent) != 0 || recheck_parent(path, path_length, owner, parent_identity) != 0
      || inspect_definition(parent, owner, published) != 0 || !published->present
      || (uint64_t)published->stat.st_dev != (uint64_t)created.st_dev
      || (uint64_t)published->stat.st_ino != (uint64_t)created.st_ino
      || published->stat.st_size != created.st_size
      || memcmp(published->sha256, digest, CC_SHA256_DIGEST_LENGTH) != 0) goto done;
  result = 0;
done:
  close(fd);
  if (!renamed) (void)unlinkat(parent, temporary, 0);
  return result;
}

struct command_result { int exit_code; unsigned char output[MAX_LAUNCHCTL_OUTPUT]; size_t output_length; };
static int set_nonblock(int fd) {
  int flags = fcntl(fd, F_GETFL);
  return flags < 0 || fcntl(fd, F_SETFL, flags | O_NONBLOCK) != 0 ? -1 : 0;
}
static int append_pipe(int fd, unsigned char *output, size_t *length, int *ended) {
  unsigned char bytes[4096];
  for (;;) {
    ssize_t count = read(fd, bytes, sizeof(bytes));
    if (count > 0) {
      if (*length + (size_t)count > MAX_LAUNCHCTL_OUTPUT) return -1;
      memcpy(output + *length, bytes, (size_t)count); *length += (size_t)count; continue;
    }
    if (count == 0) { *ended = 1; return 0; }
    if (errno == EINTR) continue;
    return errno == EAGAIN || errno == EWOULDBLOCK ? 0 : -1;
  }
}
static int retire_child(int *status) {
  if (child <= 0 || !child_owned) return -1;
  uint64_t now = now_ms(CLOCK_MONOTONIC);
  if (now == 0) return -1;
  if (retirement_deadline == 0) retirement_deadline = now + 2000U;
  (void)kill(child, SIGKILL);
  while ((now = now_ms(CLOCK_MONOTONIC)) != 0 && now < retirement_deadline) {
    pid_t result = waitpid(child, status, WNOHANG);
    if (result == child) {
      child = -1; child_owned = 0; return 0;
    }
    if (result < 0 && errno == ECHILD) { child = -1; child_owned = 0; return 0; }
    if (result < 0 && errno != EINTR) return -1;
    poll(NULL, 0, 5);
  }
  return -1;
}
static int run_launchctl(char *const argv[], struct command_result *result) {
  int out[2] = { -1, -1 }, err[2] = { -1, -1 }, status = 0, reaped = 0, out_end = 0, err_end = 0;
  unsigned char discarded[MAX_LAUNCHCTL_OUTPUT]; size_t discarded_length = 0;
  memset(result, 0, sizeof(*result));
  if (pipe(out) != 0 || pipe(err) != 0) goto failed;
  posix_spawn_file_actions_t actions; posix_spawnattr_t attributes;
  if (posix_spawn_file_actions_init(&actions) != 0) goto failed;
  if (posix_spawnattr_init(&attributes) != 0) { posix_spawn_file_actions_destroy(&actions); goto failed; }
  sigset_t mask, defaults; sigemptyset(&mask); sigfillset(&defaults);
  short flags = POSIX_SPAWN_CLOEXEC_DEFAULT | POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF;
  int setup = posix_spawn_file_actions_adddup2(&actions, out[1], STDOUT_FILENO)
    || posix_spawn_file_actions_adddup2(&actions, err[1], STDERR_FILENO)
    || posix_spawn_file_actions_addclose(&actions, out[0]) || posix_spawn_file_actions_addclose(&actions, err[0])
    || posix_spawnattr_setflags(&attributes, flags)
    || posix_spawnattr_setsigmask(&attributes, &mask) || posix_spawnattr_setsigdefault(&attributes, &defaults);
  char *environment[] = { "PATH=/usr/bin:/bin", "LANG=C", "LC_ALL=C", NULL };
  int spawned = setup ? EINVAL : posix_spawn(&child, ACR_LAUNCHCTL_PATH, &actions, &attributes, argv, environment);
  posix_spawnattr_destroy(&attributes); posix_spawn_file_actions_destroy(&actions);
  close(out[1]); out[1] = -1; close(err[1]); err[1] = -1;
  if (spawned != 0 || child <= 0 || getpgid(child) != getpgrp()
      || set_nonblock(out[0]) != 0 || set_nonblock(err[0]) != 0) goto failed;
  child_owned = 1;
  while (active() && (!reaped || !out_end || !err_end)) {
    struct pollfd pipes[2] = { { .fd = out[0], .events = POLLIN | POLLHUP, .revents = 0 },
      { .fd = err[0], .events = POLLIN | POLLHUP, .revents = 0 } };
    int ready = poll(pipes, 2, 10);
    if (ready < 0 && errno == EINTR) continue;
    if (ready < 0 || append_pipe(out[0], result->output, &result->output_length, &out_end) != 0) goto failed;
    if (append_pipe(err[0], discarded, &discarded_length, &err_end) != 0) goto failed;
    if (!reaped) {
      pid_t waited = waitpid(child, &status, WNOHANG);
      if (waited == child) reaped = 1;
      else if (waited < 0 && errno != EINTR) goto failed;
    }
  }
  if (!active() || !reaped || !out_end || !err_end || !WIFEXITED(status)) goto failed;
  result->exit_code = WEXITSTATUS(status); child = -1; child_owned = 0;
  close(out[0]); close(err[0]); return 0;
failed:
  if (child > 0) (void)retire_child(&status);
  if (out[0] >= 0) close(out[0]); if (out[1] >= 0) close(out[1]);
  if (err[0] >= 0) close(err[0]); if (err[1] >= 0) close(err[1]);
  return -1;
}
static int contains_running(const unsigned char *bytes, size_t length) {
  static const unsigned char needle[] = "state = running";
  if (length < sizeof(needle) - 1) return 0;
  for (size_t index = 0; index + sizeof(needle) - 1 <= length; index++)
    if (memcmp(bytes + index, needle, sizeof(needle) - 1) == 0) return 1;
  return 0;
}
static int service_status(uid_t owner, int definition_present, uint32_t *state, int *registered) {
  char target[128];
  int length = snprintf(target, sizeof(target), "gui/%u/%s", owner, LABEL);
  if (length < 1 || (size_t)length >= sizeof(target)) return -1;
  char *args[] = { ACR_LAUNCHCTL_PATH, "print", target, NULL };
  struct command_result result;
  if (run_launchctl(args, &result) != 0) return -1;
  if (result.exit_code == 0) {
    *registered = 1; *state = contains_running(result.output, result.output_length) ? STATE_RUNNING : STATE_STOPPED; return 0;
  }
  /* launchctl uses EX_OSERR (113) for an absent service in a valid GUI domain. */
  if (result.exit_code != 113) return -1;
  *registered = 0; *state = definition_present ? STATE_STOPPED : STATE_NOT_INSTALLED; return 0;
}
static int transition(uid_t owner, const char *path, uint32_t operation, int registered) {
  char domain[64], target[128];
  int domain_length = snprintf(domain, sizeof(domain), "gui/%u", owner);
  int target_length = snprintf(target, sizeof(target), "gui/%u/%s", owner, LABEL);
  if (domain_length < 1 || (size_t)domain_length >= sizeof(domain)
      || target_length < 1 || (size_t)target_length >= sizeof(target)) return -1;
  char *bootstrap[] = { ACR_LAUNCHCTL_PATH, "bootstrap", domain, (char *)path, NULL };
  char *kickstart[] = { ACR_LAUNCHCTL_PATH, "kickstart", target, NULL };
  char *bootout[] = { ACR_LAUNCHCTL_PATH, "bootout", target, NULL };
  struct command_result result;
  char **args = operation == OP_STOP ? bootout : registered ? kickstart : bootstrap;
  return run_launchctl(args, &result) == 0 && result.exit_code == 0 ? 0 : -1;
}
static int response(uint32_t outcome, uint32_t state, const struct stat *parent,
    const struct definition_identity *definition) {
  unsigned char bytes[RESPONSE_BYTES]; memset(bytes, 0, sizeof(bytes));
  memcpy(bytes, "ACRSVR1\n", 8); put32(bytes + 8, outcome); put32(bytes + 12, state);
  put64(bytes + 16, (uint64_t)parent->st_dev); put64(bytes + 24, (uint64_t)parent->st_ino);
  put32(bytes + 32, definition->present ? 1U : 0U);
  if (definition->present) {
    put64(bytes + 40, (uint64_t)definition->stat.st_dev); put64(bytes + 48, (uint64_t)definition->stat.st_ino);
    put64(bytes + 56, (uint64_t)definition->stat.st_size); memcpy(bytes + 64, definition->sha256, CC_SHA256_DIGEST_LENGTH);
  }
  return write(STDOUT_FILENO, bytes, sizeof(bytes)) == (ssize_t)sizeof(bytes) ? 0 : -1;
}

int main(int argc, char **argv) {
  (void)argv;
  int outcome = 1, parent = -1, registered = 0;
  unsigned char header[HEADER_BYTES], expected_sha[CC_SHA256_DIGEST_LENGTH];
  char path[MAX_PATH_BYTES + 1]; unsigned char *definition = NULL;
  struct stat parent_identity; struct definition_identity observed;
  struct sigaction action; memset(&action, 0, sizeof(action)); action.sa_handler = cancel_operation;
  sigemptyset(&action.sa_mask);
  if (sigaction(SIGTERM, &action, NULL) != 0 || sigaction(SIGINT, &action, NULL) != 0
      || sigaction(SIGHUP, &action, NULL) != 0 || signal(SIGPIPE, SIG_IGN) == SIG_ERR) return 1;
  uint64_t started = now_ms(CLOCK_MONOTONIC); deadline = started + 300000U;
  uid_t owner = geteuid();
  if (argc != 1 || started == 0 || owner == 0 || getuid() != owner || getgid() != getegid()
      || getpgrp() != getpid()
      || exact_read(header, sizeof(header)) != 0 || memcmp(header, "ACRSVC1\n", 8) != 0 || u32(header + 8) != 1) goto done;
  uint32_t operation = u32(header + 12), path_length = u32(header + 48), definition_length = u32(header + 52);
  uint32_t expected_present = u32(header + 56);
  uint64_t wall_deadline = u64(header + 24), wall_now = now_ms(CLOCK_REALTIME), mono_now = now_ms(CLOCK_MONOTONIC);
  if (operation < OP_VERIFY_PARENT || operation > OP_STOP || u64(header + 16) != owner
      || wall_deadline > SAFE_INTEGER || wall_now == 0 || mono_now == 0 || wall_deadline <= wall_now
      || wall_deadline - wall_now > 300000U || path_length < 2 || path_length > MAX_PATH_BYTES
      || definition_length > MAX_DEFINITION_BYTES || expected_present > 1 || u32(header + 60) != 0
      || (operation == OP_INSTALL) != (definition_length > 0)) goto done;
  deadline = mono_now + wall_deadline - wall_now;
  if (exact_read((unsigned char *)path, path_length) != 0) goto done;
  path[path_length] = '\0';
  if (definition_length > 0) {
    definition = malloc(definition_length);
    if (definition == NULL || exact_read(definition, definition_length) != 0) goto done;
  }
#ifdef ACR_TEST_TARGET_PATH
  if (map_test_target(path, &path_length) != 0) goto done;
#endif
  if (require_eof() != 0 || !target_valid(path, path_length)) goto done;
  parent = open_parent(path, path_length, owner, &parent_identity);
  if (parent < 0 || (uint64_t)parent_identity.st_dev != u64(header + 32)
      || (uint64_t)parent_identity.st_ino != u64(header + 40)
      || inspect_definition(parent, owner, &observed) != 0) goto done;
  memcpy(expected_sha, header + 88, sizeof(expected_sha));
  if (!matches_expected(&observed, (int)expected_present, u64(header + 64), u64(header + 72),
      u64(header + 80), expected_sha) || recheck_parent(path, path_length, owner, &parent_identity) != 0) goto done;
  uint32_t state = STATE_UNKNOWN;
  if (service_status(owner, observed.present, &state, &registered) != 0) goto done;
  if (operation == OP_INSTALL) {
    if (observed.present || registered) {
      outcome = response(OUTCOME_FAILED_BEFORE_EFFECT, state, &parent_identity, &observed) == 0 ? 0 : 1; goto done;
    }
    if (publish_definition(parent, &parent_identity, path, path_length, owner, definition, definition_length, &observed) != 0) goto done;
    state = STATE_STOPPED;
  } else if (operation == OP_START) {
    if (!observed.present || state == STATE_RUNNING) {
      outcome = response(OUTCOME_FAILED_BEFORE_EFFECT, state, &parent_identity, &observed) == 0 ? 0 : 1; goto done;
    }
    if (transition(owner, path, OP_START, registered) != 0
        || service_status(owner, 1, &state, &registered) != 0) goto done;
  } else if (operation == OP_STOP) {
    if (!registered) {
      outcome = response(OUTCOME_FAILED_BEFORE_EFFECT, state, &parent_identity, &observed) == 0 ? 0 : 1; goto done;
    }
    if (transition(owner, path, OP_STOP, registered) != 0
        || service_status(owner, observed.present, &state, &registered) != 0) goto done;
  }
  if (!active() || recheck_parent(path, path_length, owner, &parent_identity) != 0
      || inspect_definition(parent, owner, &observed) != 0) goto done;
  outcome = response(OUTCOME_SUCCEEDED, state, &parent_identity, &observed) == 0 ? 0 : 1;
done:
  if (child > 0) { int status = 0; (void)retire_child(&status); outcome = 1; }
  if (parent >= 0) close(parent);
  if (definition != NULL) { memset(definition, 0, definition_length); free(definition); }
  return outcome;
}
