/* Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Control Room's dedicated macOS installation-journal descriptor session.
 * It implements filesystem mechanics only. Plans, transitions, recovery and
 * publication decisions remain in the TypeScript journal.
 */
#ifndef __APPLE__
#error "installation-journal-session-v1 requires the reviewed macOS ACL implementation"
#endif
#include <sys/acl.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define SAFE_INTEGER UINT64_C(9007199254740991)
#define MAX_PATH_BYTES 4096U
#define MAX_NAME_BYTES 255U
#define MAX_COMPONENTS 256U
#define MAX_ENTRIES 10000U
#define MAX_PLAN_BYTES 65536U
#define MAX_WITNESS_BYTES 1024U
#define MAX_LIST_BYTES (4U + MAX_ENTRIES * (2U + MAX_NAME_BYTES))
#define OPEN_HEADER_BYTES 64U
#define COMMAND_HEADER_BYTES 44U
#define RESPONSE_HEADER_BYTES 16U
#define MAX_CREATED 4U

#ifndef ACR_JOURNAL_CHECKPOINT
#define ACR_JOURNAL_CHECKPOINT(phase, root_fd, name) ((void)0)
#endif

enum operation_kind { OP_READ = 1, OP_INSPECT = 2, OP_APPEND = 3 };
enum command_kind { CMD_LIST = 1, CMD_STAT = 2, CMD_READ = 3, CMD_CREATE = 4,
  CMD_WRITE = 5, CMD_SYNC_FILE = 6, CMD_LINK = 7, CMD_UNLINK = 8,
  CMD_SYNC_DIRECTORY = 9, CMD_VERIFY_ROOT = 10, CMD_CLOSE = 11 };

struct held_component { int fd; char name[MAX_NAME_BYTES + 1]; struct stat identity; int system_kind; };
struct created_file { int fd; char name[MAX_NAME_BYTES + 1]; struct stat identity; int state; };

static volatile sig_atomic_t cancelled = 0;
static uint64_t deadline = 0;
static uid_t expected_uid = 0;
static uint32_t selected_operation = 0;
static uint32_t next_ordinal = 1;
static int root_fd = -1;
static struct stat root_identity;
static struct held_component components[MAX_COMPONENTS];
static size_t component_count = 0;
static struct created_file created[MAX_CREATED];
static size_t created_count = 0;
static char installation_id[64];
static size_t installation_id_length = 0;

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
static uint16_t decode_u16(const unsigned char *bytes) {
  return (uint16_t)(((uint16_t)bytes[0] << 8) | bytes[1]);
}
static uint32_t decode_u32(const unsigned char *bytes) {
  uint32_t value = 0; for (size_t index = 0; index < 4; index++) value = (value << 8) | bytes[index]; return value;
}
static uint64_t decode_u64(const unsigned char *bytes) {
  uint64_t value = 0; for (size_t index = 0; index < 8; index++) value = (value << 8) | bytes[index]; return value;
}
static void encode_u16(unsigned char *bytes, uint16_t value) { bytes[0] = (unsigned char)(value >> 8); bytes[1] = (unsigned char)value; }
static void encode_u32(unsigned char *bytes, uint32_t value) {
  for (size_t index = 0; index < 4; index++) bytes[3 - index] = (unsigned char)(value >> (index * 8));
}
static void encode_u64(unsigned char *bytes, uint64_t value) {
  for (size_t index = 0; index < 8; index++) bytes[7 - index] = (unsigned char)(value >> (index * 8));
}
static int read_exact(unsigned char *bytes, size_t count) {
  while (count != 0 && active()) {
    uint64_t now = now_ms(CLOCK_MONOTONIC); if (now == 0 || now >= deadline) return -1;
    struct pollfd input = { .fd = STDIN_FILENO, .events = POLLIN, .revents = 0 };
    int result = poll(&input, 1, (int)(deadline - now)); if (result <= 0) return -1;
    ssize_t received = read(STDIN_FILENO, bytes, count);
    if (received <= 0) return -1; bytes += (size_t)received; count -= (size_t)received;
  }
  return count == 0 && active() ? 0 : -1;
}
static int write_exact(const unsigned char *bytes, size_t count) {
  while (count != 0 && active()) {
    ssize_t written = write(STDOUT_FILENO, bytes, count);
    if (written <= 0) return -1; bytes += (size_t)written; count -= (size_t)written;
  }
  return count == 0 && active() ? 0 : -1;
}
static int reply_status(uint8_t command, uint8_t status, uint32_t ordinal, const unsigned char *payload, uint32_t length) {
  unsigned char header[RESPONSE_HEADER_BYTES] = { 'A','C','R','S', command, status, 0, 0 };
  encode_u32(header + 8, ordinal); encode_u32(header + 12, length);
  return write_exact(header, sizeof(header)) == 0 && (length == 0 || write_exact(payload, length) == 0) ? 0 : -1;
}
static int reply(uint8_t command, uint32_t ordinal, const unsigned char *payload, uint32_t length) {
  return reply_status(command, 0, ordinal, payload, length);
}
static int safe_stat_identity(const struct stat *value) {
  return value->st_dev >= 0 && (uint64_t)value->st_dev <= SAFE_INTEGER && (uint64_t)value->st_ino <= SAFE_INTEGER;
}
static int same_identity(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino;
}
static int no_extended_acl(int fd) {
  acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (acl == NULL) return errno == ENOENT;
  acl_entry_t entry; int result = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry); int saved = errno; acl_free(acl);
  return result == -1 && saved == EINVAL;
}
static int private_root(int fd, struct stat *value) {
  return fstat(fd, value) == 0 && S_ISDIR(value->st_mode) && safe_stat_identity(value)
    && value->st_uid == expected_uid && (value->st_mode & 07777) == 0700 && no_extended_acl(fd);
}
static int system_component_kind(size_t index) {
  if (index == 0) return 1;
  if (index == 1 && (strcmp(components[1].name, "private") == 0 || strcmp(components[1].name, "Users") == 0)) return 1;
  if (index == 2 && strcmp(components[1].name, "private") == 0 && strcmp(components[2].name, "tmp") == 0) return 2;
  if (index == 2 && strcmp(components[1].name, "private") == 0 && strcmp(components[2].name, "var") == 0) return 1;
  if (index == 3 && strcmp(components[1].name, "private") == 0 && strcmp(components[2].name, "var") == 0
      && strcmp(components[3].name, "lib") == 0) return 1;
  return 0;
}
static int secure_component(int fd, struct stat *value, int system_kind) {
  if (fstat(fd, value) != 0 || !S_ISDIR(value->st_mode) || !safe_stat_identity(value) || !no_extended_acl(fd)) return 0;
  if (system_kind == 1) return value->st_uid == 0 && (value->st_mode & 07777) == 0755;
  if (system_kind == 2) return value->st_uid == 0 && (value->st_mode & 07777) == 01777;
  return value->st_uid == expected_uid && (value->st_mode & 07777) == 0700;
}
static int basename_valid(const char *name, size_t count) {
  if (count == 0 || count > MAX_NAME_BYTES || (count == 1 && name[0] == '.')
      || (count == 2 && name[0] == '.' && name[1] == '.')) return 0;
  for (size_t i = 0; i < count; i++) if ((unsigned char)name[i] < 32 || name[i] == 127 || name[i] == '/') return 0;
  return 1;
}
static int journal_name_valid(const char *name, size_t count) {
  if (!basename_valid(name, count) || count <= installation_id_length + 38
      || memcmp(name, installation_id, installation_id_length) != 0
      || memcmp(name + installation_id_length, ".installation-plan.revision-", 28) != 0) return 0;
  size_t offset = installation_id_length + 28;
  for (size_t i = 0; i < 10; i++) if (offset + i >= count || name[offset + i] < '0' || name[offset + i] > '9') return 0;
  offset += 10;
  if (count - offset == 5 && memcmp(name + offset, ".json", 5) == 0) return 1;
  if (count - offset == 13 && memcmp(name + offset, ".publish.json", 13) == 0) return 1;
  if (count - offset != 41 || name[offset] != '.' || memcmp(name + count - 4, ".tmp", 4) != 0) return 0;
  for (size_t i = offset + 1; i < count - 4; i++) {
    size_t position = i - offset - 1;
    if (position == 8 || position == 13 || position == 18 || position == 23) { if (name[i] != '-') return 0; }
    else if (!((name[i] >= '0' && name[i] <= '9') || (name[i] >= 'a' && name[i] <= 'f'))) return 0;
  }
  return name[offset + 15] == '4' && (name[offset + 20] == '8' || name[offset + 20] == '9'
    || name[offset + 20] == 'a' || name[offset + 20] == 'b');
}
static int ends_with(const char *name, const char *suffix) {
  size_t name_length = strlen(name), suffix_length = strlen(suffix);
  return name_length >= suffix_length && memcmp(name + name_length - suffix_length, suffix, suffix_length) == 0;
}
static int witness_name(const char *name) { return ends_with(name, ".publish.json"); }
static int temporary_name(const char *name) { return ends_with(name, ".tmp"); }
static int target_name(const char *name) { return ends_with(name, ".json") && !witness_name(name); }
static uint32_t maximum_for_name(const char *name) { return witness_name(name) ? MAX_WITNESS_BYTES : MAX_PLAN_BYTES; }
static int verify_chain(void) {
  if (!active() || component_count < 2 || root_fd != components[component_count - 1].fd) return -1;
  struct stat held;
  for (size_t i = 0; i < component_count; i++)
    if (!secure_component(components[i].fd, &held, components[i].system_kind)
        || !same_identity(&held, &components[i].identity)) return -1;
  int current = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (current < 0 || !secure_component(current, &held, components[0].system_kind)
      || !same_identity(&held, &components[0].identity)) { if (current >= 0) close(current); return -1; }
  for (size_t i = 1; i < component_count; i++) {
    int next = openat(current, components[i].name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    close(current); current = next;
    if (current < 0 || !secure_component(current, &held, components[i].system_kind)
        || !same_identity(&held, &components[i].identity)) { if (current >= 0) close(current); return -1; }
  }
  int result = private_root(current, &held) && same_identity(&held, &root_identity) ? 0 : -1;
  close(current); return result;
}
static int open_chain(const char *path, size_t length, uint64_t device, uint64_t inode) {
  if (length < 2 || length > MAX_PATH_BYTES || path[0] != '/' || path[length - 1] == '/') return -1;
  int fd = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) return -1;
  components[0].fd = fd; components[0].name[0] = '\0'; components[0].system_kind = system_component_kind(0);
  if (!secure_component(fd, &components[0].identity, components[0].system_kind)) return -1;
  component_count = 1;
  size_t start = 1;
  while (start < length) {
    size_t end = start; while (end < length && path[end] != '/') end++;
    if (component_count >= MAX_COMPONENTS || !basename_valid(path + start, end - start)) return -1;
    struct held_component *item = &components[component_count];
    memcpy(item->name, path + start, end - start); item->name[end - start] = '\0';
    item->fd = openat(components[component_count - 1].fd, item->name,
      O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    item->system_kind = system_component_kind(component_count);
    if (item->fd < 0 || !secure_component(item->fd, &item->identity, item->system_kind)) return -1;
    component_count++; start = end + 1;
  }
  root_fd = components[component_count - 1].fd;
  if (!private_root(root_fd, &root_identity) || (uint64_t)root_identity.st_dev != device
      || (uint64_t)root_identity.st_ino != inode) return -1;
  return verify_chain();
}
static int permitted(uint8_t command) {
  if (command == CMD_LIST || command == CMD_STAT || command == CMD_READ
      || command == CMD_VERIFY_ROOT || command == CMD_CLOSE) return 1;
  if (selected_operation == OP_INSPECT) return 0;
  if (command == CMD_UNLINK || command == CMD_SYNC_DIRECTORY) return 1;
  return selected_operation == OP_APPEND && (command >= CMD_CREATE && command <= CMD_LINK);
}
static struct created_file *find_created(const char *name, const struct stat *identity) {
  for (size_t i = 0; i < created_count; i++)
    if (strcmp(created[i].name, name) == 0 && same_identity(&created[i].identity, identity)) return &created[i];
  return NULL;
}
static int stat_named(const char *name, struct stat *value) {
  return fstatat(root_fd, name, value, AT_SYMLINK_NOFOLLOW);
}
static int regular_entry_has_no_acl(const char *name, const struct stat *expected) {
  int fd = openat(root_fd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) return 0;
  struct stat opened; int result = fstat(fd, &opened) == 0 && S_ISREG(opened.st_mode)
    && same_identity(&opened, expected) && no_extended_acl(fd);
  close(fd); return result;
}
static void encode_stat(unsigned char *output, const struct stat *value, int exists) {
  memset(output, 0, 40); output[0] = exists ? 1 : 0;
  if (!exists) return;
  output[1] = S_ISREG(value->st_mode) ? 1 : S_ISDIR(value->st_mode) ? 2 : 3;
  output[2] = S_ISREG(value->st_mode) ? 1 : 0;
  encode_u32(output + 4, (uint32_t)value->st_uid); encode_u32(output + 8, (uint32_t)(value->st_mode & 07777));
  encode_u32(output + 12, (uint32_t)value->st_nlink); encode_u64(output + 16, (uint64_t)value->st_size);
  encode_u64(output + 24, (uint64_t)value->st_dev); encode_u64(output + 32, (uint64_t)value->st_ino);
}
static int command_list(uint8_t command, uint32_t ordinal) {
  unsigned char *output = malloc(MAX_LIST_BYTES); if (output == NULL) return -1;
  int duplicate = openat(root_fd, ".", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  struct stat duplicate_identity;
  if (duplicate < 0 || fstat(duplicate, &duplicate_identity) != 0 || !same_identity(&duplicate_identity, &root_identity)) {
    if (duplicate >= 0) close(duplicate); free(output); return -1;
  }
  DIR *directory = fdopendir(duplicate); if (directory == NULL) { close(duplicate); free(output); return -1; }
  uint32_t count = 0, length = 4; errno = 0; struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    size_t name_length = strlen(entry->d_name);
    if ((name_length == 1 && entry->d_name[0] == '.') || (name_length == 2 && strcmp(entry->d_name, "..") == 0)) continue;
    if (++count > MAX_ENTRIES || name_length > MAX_NAME_BYTES || length + 2 + name_length > MAX_LIST_BYTES) { closedir(directory); free(output); return -1; }
    encode_u16(output + length, (uint16_t)name_length); length += 2; memcpy(output + length, entry->d_name, name_length); length += (uint32_t)name_length;
  }
  if (errno != 0 || closedir(directory) != 0) { free(output); return -1; }
  encode_u32(output, count); int result = reply(command, ordinal, output, length); free(output); return result;
}
static int command_stat(uint8_t command, uint32_t ordinal, const char *name) {
  struct stat value; unsigned char output[40];
  if (stat_named(name, &value) != 0) { if (errno != ENOENT) return -1; encode_stat(output, &value, 0); }
  else {
    if (!safe_stat_identity(&value) || value.st_size < 0 || (uint64_t)value.st_size > SAFE_INTEGER
        || (S_ISREG(value.st_mode) && !regular_entry_has_no_acl(name, &value))) return -1;
    encode_stat(output, &value, 1);
  }
  return reply(command, ordinal, output, sizeof(output));
}
static int command_read(uint8_t command, uint32_t ordinal, const char *name, uint32_t maximum) {
  if (maximum != maximum_for_name(name)) return -1;
  struct stat before, opened, after;
  if (stat_named(name, &before) != 0 || !S_ISREG(before.st_mode) || before.st_size < 1 || (uint64_t)before.st_size > maximum) return -1;
  ACR_JOURNAL_CHECKPOINT(command * 100U + 1U, root_fd, name); if (!active()) return -1;
  int fd = openat(root_fd, name, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC); if (fd < 0) return -1;
  uint32_t length = (uint32_t)before.st_size; unsigned char *output = malloc(40U + length);
  if (output == NULL || fstat(fd, &opened) != 0 || !same_identity(&before, &opened) || !S_ISREG(opened.st_mode)
      || !no_extended_acl(fd)) { if (output) free(output); close(fd); return -1; }
  size_t offset = 0; while (offset < length && active()) { ssize_t got = pread(fd, output + 40 + offset, length - offset, (off_t)offset); if (got <= 0) break; offset += (size_t)got; }
  int valid = offset == length && fstat(fd, &after) == 0 && same_identity(&opened, &after) && after.st_size == opened.st_size;
  close(fd); if (!valid) { free(output); return -1; }
  encode_stat(output, &opened, 1); int result = reply(command, ordinal, output, 40U + length); free(output); return result;
}
static int command_create(uint8_t command, uint32_t ordinal, const char *name) {
  if (created_count >= MAX_CREATED || (!temporary_name(name) && !witness_name(name))) return -1;
  ACR_JOURNAL_CHECKPOINT(command * 100U + 1U, root_fd, name); if (!active()) return -1;
  int fd = openat(root_fd, name, O_CREAT | O_EXCL | O_RDWR | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (fd < 0) return errno == EEXIST ? reply_status(command, 1, ordinal, NULL, 0) : -1;
  struct created_file *item = &created[created_count];
  if (fstat(fd, &item->identity) != 0 || !S_ISREG(item->identity.st_mode) || item->identity.st_uid != expected_uid
      || item->identity.st_nlink != 1 || (item->identity.st_mode & 07777) != 0600 || item->identity.st_size != 0
      || !no_extended_acl(fd)) { close(fd); return -1; }
  item->fd = fd; item->state = 0; strcpy(item->name, name); created_count++;
  unsigned char output[16]; encode_u64(output, (uint64_t)item->identity.st_dev); encode_u64(output + 8, (uint64_t)item->identity.st_ino);
  ACR_JOURNAL_CHECKPOINT(command * 100U + 2U, root_fd, name);
  struct stat named;
  return active() && stat_named(name, &named) == 0 && same_identity(&named, &item->identity)
    && regular_entry_has_no_acl(name, &named) ? reply(command, ordinal, output, sizeof(output)) : -1;
}
static int command_write(uint8_t command, uint32_t ordinal, const char *name, const struct stat *identity,
    const unsigned char *bytes, uint32_t length, uint32_t maximum) {
  struct created_file *item = find_created(name, identity);
  if (item == NULL || item->state != 0 || maximum != maximum_for_name(name) || length < 1 || length > maximum
      || !no_extended_acl(item->fd)) return -1;
  size_t offset = 0; while (offset < length && active()) { ssize_t put = pwrite(item->fd, bytes + offset, length - offset, (off_t)offset); if (put <= 0) return -1; offset += (size_t)put; }
  struct stat after;
  if (offset != length || fstat(item->fd, &after) != 0 || !same_identity(&after, &item->identity)
      || after.st_size != length || stat_named(name, &after) != 0 || !same_identity(&after, &item->identity)) return -1;
  item->state = 1; return reply(command, ordinal, NULL, 0);
}
static int command_sync_file(uint8_t command, uint32_t ordinal, const char *name, const struct stat *identity) {
  struct created_file *item = find_created(name, identity); if (item == NULL || item->state != 1 || !no_extended_acl(item->fd)) return -1;
  if (fsync(item->fd) != 0) return -1; struct stat after;
  if (fstat(item->fd, &after) != 0 || !same_identity(&after, &item->identity)
      || stat_named(name, &after) != 0 || !same_identity(&after, &item->identity)) return -1;
  item->state = 2; return reply(command, ordinal, NULL, 0);
}
static int command_link(uint8_t command, uint32_t ordinal, const char *source, const char *target, const struct stat *identity) {
  struct created_file *item = find_created(source, identity); struct stat named;
  if (!temporary_name(source) || !target_name(target) || item == NULL || item->state != 2 || !no_extended_acl(item->fd)
      || stat_named(source, &named) != 0 || !same_identity(&named, &item->identity)) return -1;
  ACR_JOURNAL_CHECKPOINT(command * 100U + 1U, root_fd, target); if (!active()) return -1;
  if (linkat(root_fd, source, root_fd, target, 0) != 0)
    return errno == EEXIST ? reply_status(command, 1, ordinal, NULL, 0) : -1;
  ACR_JOURNAL_CHECKPOINT(command * 100U + 2U, root_fd, target);
  if (!active() || stat_named(target, &named) != 0 || !same_identity(&named, &item->identity)) return -1;
  return reply(command, ordinal, NULL, 0);
}
static int command_unlink(uint8_t command, uint32_t ordinal, const char *name, const struct stat *identity, int allow_missing) {
  struct stat named;
  if (!temporary_name(name) && !witness_name(name)) return -1;
  if (stat_named(name, &named) != 0) {
    if (errno == ENOENT && allow_missing) return reply(command, ordinal, NULL, 0);
    return -1;
  }
  if (!S_ISREG(named.st_mode) || !same_identity(&named, identity) || !regular_entry_has_no_acl(name, &named)) return -1;
  ACR_JOURNAL_CHECKPOINT(command * 100U + 1U, root_fd, name); if (!active()) return -1;
  /* Same-owner processes are trusted by the contract. This final no-follow
   * identity check immediately precedes the only, non-retried unlinkat. */
  if (stat_named(name, &named) != 0 || !same_identity(&named, identity) || unlinkat(root_fd, name, 0) != 0) return -1;
  ACR_JOURNAL_CHECKPOINT(command * 100U + 2U, root_fd, name);
  if (!active() || (stat_named(name, &named) == 0 || errno != ENOENT)) return -1;
  return reply(command, ordinal, NULL, 0);
}
static int handle_command(const unsigned char *header) {
  uint8_t command = header[4], flags = header[5]; uint16_t name_length = decode_u16(header + 6), target_length = decode_u16(header + 8);
  uint32_t ordinal = decode_u32(header + 12), payload_length = decode_u32(header + 16);
  uint64_t device = decode_u64(header + 20), inode = decode_u64(header + 28); uint32_t maximum = decode_u32(header + 36);
  if (memcmp(header, "ACRC", 4) != 0 || header[10] != 0 || header[11] != 0
      || header[40] != 0 || header[41] != 0 || header[42] != 0 || header[43] != 0
      || command < CMD_LIST || command > CMD_CLOSE || !permitted(command)
      || ordinal != next_ordinal || flags > 1 || payload_length > MAX_PLAN_BYTES
      || device > SAFE_INTEGER || inode > SAFE_INTEGER || maximum > MAX_PLAN_BYTES) return -1;
  if (command != CMD_UNLINK && flags != 0) return -1;
  int needs_name = command == CMD_STAT || command == CMD_READ || (command >= CMD_CREATE && command <= CMD_UNLINK);
  int needs_target = command == CMD_LINK;
  if ((needs_name && (name_length == 0 || name_length > MAX_NAME_BYTES)) || (!needs_name && name_length != 0)
      || (needs_target && (target_length == 0 || target_length > MAX_NAME_BYTES)) || (!needs_target && target_length != 0)
      || (command != CMD_WRITE && payload_length != 0)) return -1;
  char name[MAX_NAME_BYTES + 1] = {0}, target[MAX_NAME_BYTES + 1] = {0}; unsigned char *payload = NULL;
  if (name_length && read_exact((unsigned char *)name, name_length) != 0) return -1;
  if (target_length && read_exact((unsigned char *)target, target_length) != 0) return -1;
  if ((name_length && !journal_name_valid(name, name_length)) || (target_length && !journal_name_valid(target, target_length))) return -1;
  if (payload_length) { payload = malloc(payload_length); if (payload == NULL || read_exact(payload, payload_length) != 0) { free(payload); return -1; } }
  struct stat identity; memset(&identity, 0, sizeof(identity)); identity.st_dev = (dev_t)device; identity.st_ino = (ino_t)inode;
  ACR_JOURNAL_CHECKPOINT(command * 100U, root_fd, name); if (!active()) { free(payload); return -1; }
  int result = -1;
  if (command == CMD_LIST) result = command_list(command, ordinal);
  else if (command == CMD_STAT) result = command_stat(command, ordinal, name);
  else if (command == CMD_READ) result = command_read(command, ordinal, name, maximum);
  else if (command == CMD_CREATE) result = command_create(command, ordinal, name);
  else if (command == CMD_WRITE) result = command_write(command, ordinal, name, &identity, payload, payload_length, maximum);
  else if (command == CMD_SYNC_FILE) result = command_sync_file(command, ordinal, name, &identity);
  else if (command == CMD_LINK) result = command_link(command, ordinal, name, target, &identity);
  else if (command == CMD_UNLINK) result = command_unlink(command, ordinal, name, &identity, flags == 1);
  else if (command == CMD_SYNC_DIRECTORY) result = fsync(root_fd) == 0 ? reply(command, ordinal, NULL, 0) : -1;
  else if (command == CMD_VERIFY_ROOT) result = verify_chain() == 0 ? reply(command, ordinal, NULL, 0) : -1;
  else if (command == CMD_CLOSE) result = verify_chain() == 0 ? reply(command, ordinal, NULL, 0) : -1;
  free(payload); if (result == 0) next_ordinal++; return result == 0 && command == CMD_CLOSE ? 1 : result;
}
static void close_all(void) {
  for (size_t i = 0; i < created_count; i++) if (created[i].fd >= 0) close(created[i].fd);
  for (size_t i = component_count; i > 0; i--) if (components[i - 1].fd >= 0) close(components[i - 1].fd);
}
int main(int argc, char **argv) {
  (void)argv; int outcome = 1; unsigned char header[OPEN_HEADER_BYTES]; char path[MAX_PATH_BYTES + 1];
  struct sigaction action; memset(&action, 0, sizeof(action)); action.sa_handler = cancel_operation; sigemptyset(&action.sa_mask);
  if (sigaction(SIGTERM, &action, NULL) != 0 || sigaction(SIGINT, &action, NULL) != 0 || signal(SIGPIPE, SIG_IGN) == SIG_ERR) return 1;
  uint64_t started = now_ms(CLOCK_MONOTONIC); if (started == 0) return 1; deadline = started + 30000U;
  if (argc != 1 || getuid() != geteuid() || getgid() != getegid() || geteuid() == 0
      || read_exact(header, sizeof(header)) != 0 || memcmp(header, "ACRJNL1\n", 8) != 0) goto done;
  selected_operation = decode_u32(header + 8); uint32_t path_length = decode_u32(header + 12), id_length = decode_u32(header + 16);
  uint64_t device = decode_u64(header + 24), inode = decode_u64(header + 32), uid = decode_u64(header + 40), wall_deadline = decode_u64(header + 48);
  if (header[20] != 0 || header[21] != 0 || header[22] != 0 || header[23] != 0
      || header[56] != 0 || header[57] != 0 || header[58] != 0 || header[59] != 0
      || header[60] != 0 || header[61] != 0 || header[62] != 0 || header[63] != 0
      || selected_operation < OP_READ || selected_operation > OP_APPEND || path_length < 2 || path_length > MAX_PATH_BYTES
      || id_length < 1 || id_length > 63 || device > SAFE_INTEGER || inode > SAFE_INTEGER || uid > INT32_MAX || uid != geteuid()) goto done;
  uint64_t wall_now = now_ms(CLOCK_REALTIME), mono_now = now_ms(CLOCK_MONOTONIC);
  if (wall_now == 0 || mono_now == 0 || wall_deadline <= wall_now || wall_deadline - wall_now > 30000U) goto done;
  uint64_t requested = mono_now + wall_deadline - wall_now; if (requested < deadline) deadline = requested; expected_uid = (uid_t)uid;
  if (read_exact((unsigned char *)path, path_length) != 0 || read_exact((unsigned char *)installation_id, id_length) != 0) goto done;
  path[path_length] = '\0'; installation_id[id_length] = '\0'; installation_id_length = id_length;
  for (size_t i = 0; i < id_length; i++) if (!((installation_id[i] >= 'a' && installation_id[i] <= 'z')
      || (installation_id[i] >= '0' && installation_id[i] <= '9') || installation_id[i] == '-')) goto done;
  if (open_chain(path, path_length, device, inode) != 0) goto done;
  ACR_JOURNAL_CHECKPOINT(1, root_fd, "");
  if (!active() || verify_chain() != 0 || reply(0, 0, NULL, 0) != 0) goto done;
  while (active()) {
    unsigned char command[COMMAND_HEADER_BYTES]; if (read_exact(command, sizeof(command)) != 0) goto done;
    int result = handle_command(command); if (result < 0) goto done; if (result == 1) { outcome = 0; goto done; }
  }
done:
  close_all(); return outcome;
}
