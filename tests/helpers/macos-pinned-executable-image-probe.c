#ifndef __APPLE__
#error "macOS-only test probe"
#endif
#define _DARWIN_C_SOURCE
#include <sys/stat.h>
#include <sys/wait.h>
#include <spawn.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <time.h>
#include <unistd.h>
#include "macos-suspended-mapped-vnode-observation.h"

extern char **environ;

static int retire(pid_t child) {
  if (kill(child, SIGKILL) != 0 && errno != ESRCH) return -1;
  int status = 0;
  while (waitpid(child, &status, 0) < 0) if (errno != EINTR) return -1;
  return 0;
}

static int overwrite_same_inode(const char *source, const char *destination) {
  int input = open(source, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  int output = open(destination, O_WRONLY | O_TRUNC | O_NOFOLLOW | O_CLOEXEC);
  if (input < 0 || output < 0) return -1;
  unsigned char bytes[16384];
  for (;;) {
    ssize_t count = read(input, bytes, sizeof(bytes));
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) return -1;
    if (count == 0) break;
    ssize_t offset = 0;
    while (offset < count) {
      ssize_t written = write(output, bytes + offset, (size_t)(count - offset));
      if (written < 0 && errno == EINTR) continue;
      if (written <= 0) return -1;
      offset += written;
    }
  }
  return close(input) == 0 && close(output) == 0 ? 0 : -1;
}

static int await_match(pid_t child, const struct stat *identity) {
  struct timespec pause = { .tv_sec = 0, .tv_nsec = 5000000 };
  for (unsigned attempt = 0; attempt < 100; attempt++) {
    if (acr_test_macos_suspended_mapped_vnode_matches(
          child, getpid(), geteuid(), identity) == 0) return 0;
    (void)nanosleep(&pause, NULL);
  }
  return -1;
}

int main(int argc, char **argv) {
  if (argc != 3 && argc != 4 && argc != 5) return 20;
  int held = open(argv[1], O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
  struct stat identity;
  if (held < 0 || fstat(held, &identity) != 0 || !S_ISREG(identity.st_mode)) return 21;
  /* Test-only mutations after the reviewed descriptor is held. */
  if (argc == 4 && rename(argv[2], argv[1]) != 0) return 22;
  if (argc == 5 && overwrite_same_inode(argv[2], argv[1]) != 0) return 27;

  posix_spawnattr_t attributes;
  if (posix_spawnattr_init(&attributes) != 0) return 23;
  if (posix_spawnattr_setflags(&attributes, POSIX_SPAWN_START_SUSPENDED) != 0)
    return 24;
  pid_t child = -1;
  char *child_argv[] = { argv[1], argv[argc - 1], NULL };
  int spawned = posix_spawn(&child, argv[1], NULL, &attributes, child_argv, environ);
  posix_spawnattr_destroy(&attributes);
  if (spawned != 0 || child <= 0) return 25;

  int matched = await_match(child, &identity) == 0;
  int cleaned = retire(child);
  close(held);
  if (cleaned != 0) return 26;
  return matched ? 0 : 10;
}
