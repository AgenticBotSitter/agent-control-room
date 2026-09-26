/* Licensed under the Apache License, Version 2.0. Control Room's fixed-purpose
 * macOS installed-configuration publisher and descriptor verifier. It accepts
 * one private binary frame, never invokes a shell, never reads the environment,
 * and emits only bounded path-free identity evidence. Configuration bytes are
 * cleared before exit and are never written to stdout or stderr.
 */
#ifndef __APPLE__
#error "installed-configuration-v1 requires the reviewed macOS ACL implementation"
#endif
#include <sys/acl.h>
#include <sys/param.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define SAFE_INTEGER UINT64_C(9007199254740991)
#define HEADER_BYTES 72U
#define MAX_PATH_BYTES 4096U
#define MAX_NAME_BYTES 255U
#define MAX_COMPONENTS 64U
#define MAX_INSTALLATION_BYTES 63U
#define DIGEST_BYTES 71U
#define MAX_CONFIGURATION_BYTES 262144U
#define MAX_MANIFEST_BYTES 16384U
#define HELD_DESCRIPTOR 3

#ifndef ACR_TEST_ROOT_PREFIX
#define ACR_TEST_ROOT_PREFIX ""
#endif

enum operation_kind { OP_PUBLISH = 1, OP_VERIFY = 2 };
enum verification_kind { KIND_ANCESTOR = 1, KIND_MANIFEST = 2, KIND_CONFIGURATION = 3, KIND_JOURNAL = 4 };
struct component { int fd; char name[MAX_NAME_BYTES + 1]; struct stat identity; };

static volatile sig_atomic_t cancelled = 0;
static uint64_t deadline = 0;
static uid_t expected_uid = 0;
static struct component components[MAX_COMPONENTS];
static size_t component_count = 0;

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
static uint32_t decode_u32(const unsigned char *bytes) {
  uint32_t value = 0;
  for (size_t index = 0; index < 4; index++) value = (value << 8) | bytes[index];
  return value;
}
static uint64_t decode_u64(const unsigned char *bytes) {
  uint64_t value = 0;
  for (size_t index = 0; index < 8; index++) value = (value << 8) | bytes[index];
  return value;
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
    bytes += (size_t)received; count -= (size_t)received;
  }
  return count == 0 && active() ? 0 : -1;
}
static int write_exact(const unsigned char *bytes, size_t count) {
  while (count != 0 && active()) {
    ssize_t written = write(STDOUT_FILENO, bytes, count);
    if (written <= 0) return -1;
    bytes += (size_t)written; count -= (size_t)written;
  }
  return count == 0 && active() ? 0 : -1;
}
static int safe_identity(const struct stat *value) {
  return value->st_dev >= 0 && (uint64_t)value->st_dev <= SAFE_INTEGER
    && (uint64_t)value->st_ino <= SAFE_INTEGER;
}
static int same_identity(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino;
}
static int no_extended_acl(int fd) {
  acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (acl == NULL) return errno == ENOENT;
  acl_entry_t entry;
  int result = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry), saved = errno;
  acl_free(acl);
  return result == -1 && saved == EINVAL;
}
static int harmless_ancestor_acl(int fd, int *extended) {
  static const unsigned char everyone[16] = {
    0xab, 0xcd, 0xef, 0xab, 0xcd, 0xef, 0xab, 0xcd,
    0xef, 0xab, 0xcd, 0xef, 0x00, 0x00, 0x00, 0x0c,
  };
  acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (acl == NULL) { *extended = 0; return errno == ENOENT; }
  acl_entry_t entry;
  int found = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry);
  if (found == -1 && errno == EINVAL) { acl_free(acl); *extended = 0; return 1; }
  int valid = found == 0;
  acl_tag_t tag; acl_permset_mask_t permissions = 0; acl_flagset_t flags;
  void *qualifier = NULL;
  if (valid) {
    qualifier = acl_get_qualifier(entry);
    valid = qualifier != NULL && memcmp(qualifier, everyone, sizeof(everyone)) == 0
      && acl_get_tag_type(entry, &tag) == 0 && tag == ACL_EXTENDED_DENY
      && acl_get_permset_mask_np(entry, &permissions) == 0
      && permissions == (acl_permset_mask_t)ACL_DELETE
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
  acl_free(acl); *extended = valid ? 1 : 0; return valid;
}
static int basename_valid(const char *name, size_t count) {
  if (count == 0 || count > MAX_NAME_BYTES || (count == 1 && name[0] == '.')
      || (count == 2 && name[0] == '.' && name[1] == '.')) return 0;
  for (size_t index = 0; index < count; index++)
    if ((unsigned char)name[index] < 32 || name[index] == 127 || name[index] == '/') return 0;
  return 1;
}
static int installation_valid(const char *value, size_t count) {
  if (count == 0 || count == 2 || count > MAX_INSTALLATION_BYTES
      || !((value[0] >= 'a' && value[0] <= 'z') || (value[0] >= '0' && value[0] <= '9'))
      || !((value[count - 1] >= 'a' && value[count - 1] <= 'z')
        || (value[count - 1] >= '0' && value[count - 1] <= '9'))) return 0;
  for (size_t index = 0; index < count; index++)
    if (!((value[index] >= 'a' && value[index] <= 'z') || (value[index] >= '0' && value[index] <= '9')
        || value[index] == '-')) return 0;
  return 1;
}
static int digest_valid(const char *value) {
  if (memcmp(value, "sha256:", 7) != 0) return 0;
  for (size_t index = 7; index < DIGEST_BYTES; index++)
    if (!((value[index] >= '0' && value[index] <= '9') || (value[index] >= 'a' && value[index] <= 'f'))) return 0;
  return 1;
}
static int standard_root(const char *path, size_t count) {
  static const char prefix[] = "/Users/";
  static const char suffix[] = "/Library/Application Support/Agent Control Room/Protected";
  size_t prefix_count = sizeof(prefix) - 1, suffix_count = sizeof(suffix) - 1;
  if (count <= prefix_count + suffix_count || memcmp(path, prefix, prefix_count) != 0
      || memcmp(path + count - suffix_count, suffix, suffix_count) != 0) return 0;
  size_t owner_count = count - prefix_count - suffix_count;
  return basename_valid(path + prefix_count, owner_count);
}
static int secure_directory(int fd, struct stat *value) {
  int extended = 0;
  if (fstat(fd, value) != 0 || !S_ISDIR(value->st_mode) || !safe_identity(value)
      || !harmless_ancestor_acl(fd, &extended)) return 0;
  if (value->st_uid != 0 && value->st_uid != expected_uid) return 0;
  return (value->st_mode & 0022) == 0 || (value->st_uid == 0 && (value->st_mode & 07777) == 01777);
}
static void close_components(void) {
  while (component_count != 0) { component_count--; close(components[component_count].fd); }
}
static int open_chain(const char *path, size_t length) {
  if (length == 0 || length > MAX_PATH_BYTES || path[0] != '/' || (length > 1 && path[length - 1] == '/')) return -1;
  component_count = 0;
  int current = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (current < 0) return -1;
  components[0].fd = current; components[0].name[0] = '\0';
  if (!secure_directory(current, &components[0].identity)) { close_components(); return -1; }
  component_count = 1;
  if (length == 1) return current;
  for (size_t start = 1; start < length && active();) {
    size_t end = start;
    while (end < length && path[end] != '/') end++;
    if (component_count >= MAX_COMPONENTS || !basename_valid(path + start, end - start)) { close_components(); return -1; }
    struct component *item = &components[component_count];
    memcpy(item->name, path + start, end - start); item->name[end - start] = '\0';
    item->fd = openat(current, item->name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (item->fd < 0 || !secure_directory(item->fd, &item->identity)) {
      if (item->fd >= 0) close(item->fd); close_components(); return -1;
    }
    current = item->fd; component_count++; start = end + 1;
  }
  return active() ? current : -1;
}
static int verify_chain(void) {
  if (!active() || component_count == 0) return -1;
  struct stat observed;
  for (size_t index = 0; index < component_count; index++)
    if (!secure_directory(components[index].fd, &observed) || !same_identity(&observed, &components[index].identity)) return -1;
  int current = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (current < 0 || !secure_directory(current, &observed) || !same_identity(&observed, &components[0].identity)) {
    if (current >= 0) close(current); return -1;
  }
  for (size_t index = 1; index < component_count; index++) {
    int next = openat(current, components[index].name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    close(current); current = next;
    if (current < 0 || !secure_directory(current, &observed)
        || !same_identity(&observed, &components[index].identity)) { if (current >= 0) close(current); return -1; }
  }
  close(current); return 0;
}
static int private_root(int fd, struct stat *value) {
  return secure_directory(fd, value) && no_extended_acl(fd)
    && value->st_uid == expected_uid && (value->st_mode & 07777) == 0700;
}
static int absent(int fd, const char *name) {
  struct stat value;
  return fstatat(fd, name, &value, AT_SYMLINK_NOFOLLOW) != 0 && errno == ENOENT;
}
static int exact_file(int parent, const char *name, int fd, const struct stat *identity, uint64_t size) {
  struct stat opened, named;
  return fstat(fd, &opened) == 0 && fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) == 0
    && S_ISREG(opened.st_mode) && same_identity(&opened, &named) && same_identity(&opened, identity)
    && opened.st_uid == expected_uid && (opened.st_mode & 07777) == 0600 && opened.st_nlink == 1
    && opened.st_size >= 0 && (uint64_t)opened.st_size == size && no_extended_acl(fd);
}
static int exact_private_directory(int parent, const char *name, int fd, const struct stat *identity) {
  struct stat opened, named;
  return private_root(fd, &opened) && fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) == 0
    && same_identity(&opened, &named) && same_identity(&opened, identity);
}
static int create_write_file(int root, const char *name, const unsigned char *bytes, uint32_t count,
    int *result_fd, struct stat *identity) {
  int fd = openat(root, name, O_CREAT | O_EXCL | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0 || fstat(fd, identity) != 0 || !S_ISREG(identity->st_mode) || !safe_identity(identity)
      || identity->st_uid != expected_uid || (identity->st_mode & 07777) != 0600
      || identity->st_nlink != 1 || !no_extended_acl(fd)) { if (fd >= 0) close(fd); return -1; }
  size_t offset = 0;
  while (offset < count && active()) {
    ssize_t written = pwrite(fd, bytes + offset, (size_t)count - offset, (off_t)offset);
    if (written <= 0) { close(fd); return -1; }
    offset += (size_t)written;
  }
  if (!active() || fsync(fd) != 0 || !exact_file(root, name, fd, identity, count)) { close(fd); return -1; }
  unsigned char compare[4096]; offset = 0;
  while (offset < count && active()) {
    size_t wanted = (size_t)count - offset < sizeof(compare) ? (size_t)count - offset : sizeof(compare);
    ssize_t received = pread(fd, compare, wanted, (off_t)offset);
    if (received <= 0 || memcmp(compare, bytes + offset, (size_t)received) != 0) { memset(compare, 0, sizeof(compare)); close(fd); return -1; }
    memset(compare, 0, sizeof(compare)); offset += (size_t)received;
  }
  *result_fd = fd; return active() ? 0 : -1;
}
static int publish(char *path, size_t path_count, const unsigned char *configuration, uint32_t configuration_count,
    const unsigned char *manifest, uint32_t manifest_count) {
  static const char final_name[] = "Protected", temporary_name[] = ".Protected.acr-new";
  int parent = -1, root = -1, config_fd = -1, manifest_fd = -1, journal_fd = -1;
  int temporary_created = 0, renamed = 0;
  struct stat parent_identity, root_identity, config_identity, manifest_identity, journal_identity, observed, named;
  if (!standard_root(path, path_count)) goto failed;
  static const char test_prefix[] = ACR_TEST_ROOT_PREFIX;
  size_t prefix_count = sizeof(test_prefix) - 1;
  if (prefix_count + path_count > MAX_PATH_BYTES) goto failed;
  char resolved_path[MAX_PATH_BYTES + 1];
  memcpy(resolved_path, test_prefix, prefix_count); memcpy(resolved_path + prefix_count, path, path_count + 1);
  char *slash = strrchr(resolved_path, '/');
  if (slash == NULL || strcmp(slash + 1, final_name) != 0) goto failed;
  *slash = '\0';
  parent = open_chain(resolved_path, strlen(resolved_path));
  if (parent < 0 || !secure_directory(parent, &parent_identity) || !absent(parent, final_name)
      || !absent(parent, temporary_name)) goto failed;
  umask(077);
  if (mkdirat(parent, temporary_name, 0700) != 0) goto failed;
  temporary_created = 1;
  root = openat(parent, temporary_name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (root < 0 || !private_root(root, &root_identity)
      || fstatat(parent, temporary_name, &named, AT_SYMLINK_NOFOLLOW) != 0
      || !same_identity(&root_identity, &named)) goto failed;
  if (mkdirat(root, "installation-journal", 0700) != 0) goto failed;
  journal_fd = openat(root, "installation-journal", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (journal_fd < 0 || !private_root(journal_fd, &journal_identity)
      || create_write_file(root, "operator.json", configuration, configuration_count, &config_fd, &config_identity) != 0
      || create_write_file(root, "installed-manifest.json", manifest, manifest_count, &manifest_fd, &manifest_identity) != 0
      || fsync(journal_fd) != 0 || fsync(root) != 0) goto failed;
  if (!active() || verify_chain() != 0 || !secure_directory(parent, &observed)
      || !same_identity(&observed, &parent_identity)
#ifdef ACR_TEST_FAULT_BEFORE_RENAME
      || 1
#endif
      || renameatx_np(parent, temporary_name, parent, final_name, RENAME_EXCL) != 0) goto failed;
  renamed = 1;
  if (fsync(parent) != 0) goto failed;
  if (fstatat(parent, final_name, &named, AT_SYMLINK_NOFOLLOW) != 0 || !same_identity(&named, &root_identity)
      || !private_root(root, &observed) || !same_identity(&observed, &root_identity)
      || !exact_file(root, "operator.json", config_fd, &config_identity, configuration_count)
      || !exact_file(root, "installed-manifest.json", manifest_fd, &manifest_identity, manifest_count)
      || !exact_private_directory(root, "installation-journal", journal_fd, &journal_identity)
      || verify_chain() != 0
      || fstatat(parent, final_name, &named, AT_SYMLINK_NOFOLLOW) != 0 || !same_identity(&named, &root_identity)
      || !exact_file(root, "operator.json", config_fd, &config_identity, configuration_count)
      || !exact_file(root, "installed-manifest.json", manifest_fd, &manifest_identity, manifest_count)
      || !exact_private_directory(root, "installation-journal", journal_fd, &journal_identity)) goto failed;
#ifdef ACR_TEST_FAULT_AFTER_RENAME_BEFORE_REPLY
  goto failed;
#endif
  {
    char response[320];
    int length = snprintf(response, sizeof(response),
      "ACRCFG1 P %" PRIu64 " %" PRIu64 " %" PRIu64 " %" PRIu64 " %" PRIu64 " %" PRIu64
      " %" PRIu64 " %" PRIu64 " %" PRIu64 " %u %u\n",
      (uint64_t)root_identity.st_dev, (uint64_t)root_identity.st_ino,
      (uint64_t)config_identity.st_dev, (uint64_t)config_identity.st_ino,
      (uint64_t)manifest_identity.st_dev, (uint64_t)manifest_identity.st_ino,
      (uint64_t)journal_identity.st_dev, (uint64_t)journal_identity.st_ino,
      (uint64_t)expected_uid, configuration_count, manifest_count);
    if (length < 1 || (size_t)length >= sizeof(response)
        || write_exact((const unsigned char *)response, (size_t)length) != 0) goto failed;
  }
  close(journal_fd); close(manifest_fd); close(config_fd); close(root); close_components(); return 0;
failed:
  /* Before the atomic visibility point, roll back only the exact objects this
   * invocation still holds. A substituted or ambiguous object is deliberately
   * left for owner inspection instead of broad name-based cleanup. */
  if (temporary_created && !renamed && parent >= 0 && root >= 0
      && config_fd >= 0 && manifest_fd >= 0 && journal_fd >= 0
      && absent(parent, final_name)
      && fstatat(parent, temporary_name, &named, AT_SYMLINK_NOFOLLOW) == 0
      && same_identity(&named, &root_identity)
      && private_root(root, &observed) && same_identity(&observed, &root_identity)
      && exact_file(root, "installed-manifest.json", manifest_fd, &manifest_identity, manifest_count)
      && exact_file(root, "operator.json", config_fd, &config_identity, configuration_count)
      && exact_private_directory(root, "installation-journal", journal_fd, &journal_identity)) {
    int cleanup_ok = 1;
    if (unlinkat(root, "installed-manifest.json", 0) != 0) cleanup_ok = 0;
    if (cleanup_ok && unlinkat(root, "operator.json", 0) != 0) cleanup_ok = 0;
    if (cleanup_ok && unlinkat(root, "installation-journal", AT_REMOVEDIR) != 0) cleanup_ok = 0;
    if (cleanup_ok && fsync(root) == 0
        && unlinkat(parent, temporary_name, AT_REMOVEDIR) == 0) (void)fsync(parent);
  }
  if (journal_fd >= 0) close(journal_fd);
  if (manifest_fd >= 0) close(manifest_fd);
  if (config_fd >= 0) close(config_fd);
  if (root >= 0) close(root);
  close_components(); return -1;
}
static int verify_reply(uint8_t kind, const struct stat *held, uint32_t mode, int extended) {
  char response[192];
  int length = snprintf(response, sizeof(response), "ACRCFG1 V %u %" PRIu64 " %" PRIu64 " %" PRIu64 " %u %u\n",
    (unsigned int)kind, (uint64_t)held->st_dev, (uint64_t)held->st_ino, (uint64_t)held->st_uid, mode,
    extended ? 1U : 0U);
  return length > 0 && (size_t)length < sizeof(response)
    && write_exact((const unsigned char *)response, (size_t)length) == 0 ? 0 : -1;
}
static int verify_descriptor(uint8_t kind, uint64_t device, uint64_t inode, uint32_t mode) {
  char path[MAXPATHLEN]; struct stat held, named; int extended = 0;
  if (kind < KIND_ANCESTOR || kind > KIND_JOURNAL || fcntl(HELD_DESCRIPTOR, F_GETPATH, path) != 0
      || path[0] != '/' || strlen(path) > MAX_PATH_BYTES || fstat(HELD_DESCRIPTOR, &held) != 0
      || !safe_identity(&held) || (uint64_t)held.st_dev != device || (uint64_t)held.st_ino != inode
      || (held.st_uid != expected_uid && kind != KIND_ANCESTOR) || (held.st_mode & 07777) != mode) return -1;
  if (kind == KIND_ANCESTOR) {
    if (!harmless_ancestor_acl(HELD_DESCRIPTOR, &extended)) return -1;
    size_t path_length = strlen(path); static const char protected_suffix[] = "/Protected";
    size_t suffix_length = sizeof(protected_suffix) - 1;
    if (path_length >= suffix_length && strcmp(path + path_length - suffix_length, protected_suffix) == 0
        && extended) return -1;
  } else if (!no_extended_acl(HELD_DESCRIPTOR)) return -1;
  if (strcmp(path, "/") == 0) {
    if (kind != KIND_ANCESTOR || !secure_directory(HELD_DESCRIPTOR, &named) || !same_identity(&named, &held)) return -1;
    return verify_reply(kind, &held, mode, extended);
  }
  char *slash = strrchr(path, '/');
  if (slash == NULL) return -1;
  size_t name_count = strlen(slash + 1); char name[MAX_NAME_BYTES + 1];
  if (!basename_valid(slash + 1, name_count)) return -1;
  memcpy(name, slash + 1, name_count + 1);
  if (slash == path) slash[1] = '\0'; else *slash = '\0';
  int parent = open_chain(path, strlen(path));
  if (parent < 0 || fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) != 0
      || !same_identity(&named, &held)) { close_components(); return -1; }
  if (kind == KIND_ANCESTOR) {
    if (!S_ISDIR(held.st_mode) || !secure_directory(HELD_DESCRIPTOR, &named) || !same_identity(&named, &held)) { close_components(); return -1; }
  } else if (kind == KIND_JOURNAL) {
    if (!S_ISDIR(held.st_mode) || held.st_uid != expected_uid || mode != 0700) { close_components(); return -1; }
  } else if (!S_ISREG(held.st_mode) || held.st_uid != expected_uid || mode != 0600 || held.st_nlink != 1) {
    close_components(); return -1;
  }
  if (verify_chain() != 0 || fstat(HELD_DESCRIPTOR, &named) != 0 || !same_identity(&named, &held)
      || fstatat(parent, name, &named, AT_SYMLINK_NOFOLLOW) != 0 || !same_identity(&named, &held)) {
    close_components(); return -1;
  }
  close_components();
  return verify_reply(kind, &held, mode, extended);
}

int main(int argc, char **argv) {
  (void)argv;
  unsigned char header[HEADER_BYTES]; char path[MAX_PATH_BYTES + 1], installation[MAX_INSTALLATION_BYTES + 1];
  char release_digest[DIGEST_BYTES + 1], plan_digest[DIGEST_BYTES + 1];
  unsigned char *configuration = NULL, *manifest = NULL; int outcome = 1;
  struct sigaction action; memset(&action, 0, sizeof(action)); action.sa_handler = cancel_operation; sigemptyset(&action.sa_mask);
  if (sigaction(SIGTERM, &action, NULL) != 0 || sigaction(SIGINT, &action, NULL) != 0
      || signal(SIGPIPE, SIG_IGN) == SIG_ERR || argc != 1) return 1;
  uint64_t started = now_ms(CLOCK_MONOTONIC); if (started == 0) return 1; deadline = started + 30000U;
  if (getuid() != geteuid() || getgid() != getegid() || geteuid() == 0 || read_exact(header, sizeof(header)) != 0
      || memcmp(header, "ACRCFG1\n", 8) != 0) goto done;
  uint8_t operation = header[8], kind = header[9];
  for (size_t index = 10; index < 16; index++) if (header[index] != 0) goto done;
  uint32_t path_count = decode_u32(header + 16), installation_count = decode_u32(header + 20);
  uint32_t configuration_count = decode_u32(header + 24), manifest_count = decode_u32(header + 28);
  uint64_t device = decode_u64(header + 32), inode = decode_u64(header + 40), uid = decode_u64(header + 48);
  uint64_t wall_deadline = decode_u64(header + 56); uint32_t mode = decode_u32(header + 64);
  if (decode_u32(header + 68) != 0 || path_count > MAX_PATH_BYTES || installation_count > MAX_INSTALLATION_BYTES
      || configuration_count > MAX_CONFIGURATION_BYTES || manifest_count > MAX_MANIFEST_BYTES
      || device > SAFE_INTEGER || inode > SAFE_INTEGER || uid > INT32_MAX || uid != geteuid()) goto done;
  expected_uid = (uid_t)uid;
  uint64_t wall_now = now_ms(CLOCK_REALTIME), mono_now = now_ms(CLOCK_MONOTONIC);
  if (wall_now == 0 || mono_now == 0 || wall_deadline <= wall_now || wall_deadline - wall_now > 30000U) goto done;
  uint64_t requested = mono_now + wall_deadline - wall_now; if (requested < deadline) deadline = requested;
  if (read_exact((unsigned char *)path, path_count) != 0
      || read_exact((unsigned char *)installation, installation_count) != 0
      || read_exact((unsigned char *)release_digest, DIGEST_BYTES) != 0
      || read_exact((unsigned char *)plan_digest, DIGEST_BYTES) != 0) goto done;
  path[path_count] = '\0'; installation[installation_count] = '\0'; release_digest[DIGEST_BYTES] = '\0'; plan_digest[DIGEST_BYTES] = '\0';
  if (!installation_valid(installation, installation_count) || !digest_valid(release_digest) || !digest_valid(plan_digest)) goto done;
  if (operation == OP_PUBLISH) {
    if (kind != 0 || path_count < 2 || configuration_count == 0 || manifest_count == 0 || device != 0 || inode != 0 || mode != 0) goto done;
    configuration = malloc(configuration_count); manifest = malloc(manifest_count);
    if (configuration == NULL || manifest == NULL || read_exact(configuration, configuration_count) != 0
        || read_exact(manifest, manifest_count) != 0) goto done;
  } else if (operation != OP_VERIFY || path_count != 0 || configuration_count != 0 || manifest_count != 0) goto done;
  {
    struct pollfd input = { .fd = STDIN_FILENO, .events = POLLIN, .revents = 0 }; unsigned char extra;
    uint64_t now = now_ms(CLOCK_MONOTONIC);
    if (now == 0 || now >= deadline || poll(&input, 1, (int)(deadline - now)) <= 0 || read(STDIN_FILENO, &extra, 1) != 0) goto done;
  }
  if (operation == OP_PUBLISH) outcome = publish(path, path_count, configuration, configuration_count, manifest, manifest_count) == 0 ? 0 : 1;
  else outcome = verify_descriptor(kind, device, inode, mode) == 0 ? 0 : 1;
done:
  if (configuration != NULL) { memset(configuration, 0, configuration_count); free(configuration); }
  if (manifest != NULL) { memset(manifest, 0, manifest_count); free(manifest); }
  memset(path, 0, sizeof(path)); memset(installation, 0, sizeof(installation));
  memset(release_digest, 0, sizeof(release_digest)); memset(plan_digest, 0, sizeof(plan_digest));
  close_components(); return outcome;
}
