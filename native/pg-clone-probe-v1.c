/* Control Room's clone probe: one clonefile(2) call, no fallback, no repair.
 *
 * Why a native binary at all, when the runtime is Node:
 *
 *   The only operation on this platform that reports "this was a real clone"
 *   rather than "this succeeded somehow" is clonefile(2), because it has no
 *   copy fallback (man 2 clonefile: [ENOTSUP] the underlying filesystem does
 *   not support this call). Every Node-reachable alternative was MEASURED and
 *   is unusable for the verdict:
 *
 *     fs.copyFileSync(src, dst, COPYFILE_FICLONE_FORCE)
 *         ENOSYS on APFS, on /tmp, everywhere -- libuv 1.52.1 maps it to
 *         COPYFILE_CLONE|COPYFILE_CLONE_FORCE and the kernel rejects that pair.
 *     fcopyfile(..., COPYFILE_CLONE_FORCE) from C
 *         returns 0 on APFS *and* on a FAT32 image, so it is advisory too.
 *     COPYFILE_STATE_WAS_CLONED
 *         unset on both; copyfile_state_get returns 0 and never writes the value.
 *
 *   So the probe needs this sidecar. It is a single syscall in a program with
 *   no loop over a tree, no retry and no repair, because the property being
 *   bought is that no code between the caller and the kernel can turn a
 *   refusal into a success.
 *
 * Protocol: argv is (sourceDirectory, destinationDirectory, bytes).
 *   stdout, exactly one line:
 *     "ok <bytes>"      clonefile(2) returned 0: the volume performed a clone.
 *     "errno <n>"       anything else. The caller treats every n as a refusal.
 *   stderr is unused. The exit status is 0 for both shapes and carries no
 *   meaning, so a caller cannot accidentally branch on "it exited 0" -- which is
 *   the mistake that made `cp -c` unsafe in the first place.
 *
 * Trust boundary: the caller chooses the directories and must have already
 * proved they are root-owned with no group or other write bit (R-FS/T1). This
 * program does no ownership check of its own because the probe's purpose is to
 * measure the volume, and a check that could refuse would turn a measurement into
 * a policy decision. Both probe files are created with O_EXCL, so neither can be
 * a symlink or any other pre-existing name.
 */
#ifndef __APPLE__
#error "pg-clone-probe requires the reviewed macOS clonefile(2) implementation"
#endif
#include <sys/stat.h>
#include <sys/types.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* clonefile(2) is declared in <sys/clonefile.h> on modern SDKs. Declaring it
 * here keeps this file building against the Command Line Tools SDK without
 * depending on which of the two the machine has; the signature is fixed by the
 * ABI as (const char *, const char *, int). */
extern int clonefile(const char *src, const char *dst, int flags);

/* CLONE_NOFOLLOW, pinned here rather than included so the value is this file's
 * own claim and not whichever SDK happens to be installed. It is 0x0001 in every
 * SDK and in the man page. */
#define CR_CLONE_NOFOLLOW 0x0001

#define CR_DIR_MAX 900
#define CR_NAME_MAX 64
#define CR_PATH_MAX 1024
#define CR_PROBE_MAX_BYTES (64U * 1024U * 1024U)

/* Join `directory` and a name this program generates. Refuses a directory that
 * is too long or has a trailing slash: a doubled separator is not an error
 * clonefile(2) reports differently, which would make the returned errno
 * ambiguous between ENOENT and ENOTSUP. */
static int join_probe_path(char *out, size_t capacity, const char *directory, const char *name) {
  size_t directory_length = strlen(directory);
  size_t name_length = strlen(name);
  if (directory_length == 0 || directory_length > CR_DIR_MAX) return -1;
  if (directory[directory_length - 1] == '/') return -1;
  if (name_length == 0 || name_length > CR_NAME_MAX) return -1;
  if (directory_length + 1 + name_length + 1 > capacity) return -1;
  memcpy(out, directory, directory_length);
  out[directory_length] = '/';
  memcpy(out + directory_length + 1, name, name_length);
  out[directory_length + 1 + name_length] = '\0';
  return 0;
}

/* Write `bytes` of non-sparse filler at `path`, O_EXCL. Returns 0, or errno.
 *
 * Non-sparse on purpose: a sparse probe would let a filesystem charge almost
 * nothing for either a clone or a full copy, and a measurement built on "the
 * volume charged very little" is exactly the measurement finding 12 rejects. */
static int write_probe_file(const char *path, uint64_t bytes) {
  int descriptor = open(path, O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (descriptor < 0) return errno;
  static char block[4096];
  memset(block, 0x5a, sizeof block);
  uint64_t written = 0;
  while (written < bytes) {
    size_t chunk = (bytes - written) < sizeof block ? (size_t)(bytes - written) : sizeof block;
    size_t offset = 0;
    while (offset < chunk) {
      ssize_t n = write(descriptor, block + offset, chunk - offset);
      if (n < 0) {
        if (errno == EINTR) continue;
        int saved = errno;
        close(descriptor);
        unlink(path);
        return saved;
      }
      offset += (size_t)n;
    }
    written += chunk;
  }
  /* fsync before closing: clonefile(2) clones the source's blocks, and cloning a
   * file whose blocks are not yet on disk is not a question this program should
   * be answering on the caller's behalf. */
  if (fsync(descriptor) != 0) {
    int saved = errno;
    close(descriptor);
    unlink(path);
    return saved;
  }
  if (close(descriptor) != 0) {
    int saved = errno;
    unlink(path);
    return saved;
  }
  return 0;
}

int main(int argc, char **argv) {
  if (argc != 4) {
    fprintf(stderr, "usage: pg-clone-probe <source-dir> <destination-dir> <bytes>\n");
    return 64;
  }
  const char *source_directory = argv[1];
  const char *destination_directory = argv[2];

  char *end = NULL;
  errno = 0;
  unsigned long long parsed = strtoull(argv[3], &end, 10);
  if (errno != 0 || end == argv[3] || *end != '\0' || parsed == 0
    || parsed > (unsigned long long)CR_PROBE_MAX_BYTES) {
    printf("errno %d\n", EINVAL);
    return 0;
  }
  uint64_t bytes = (uint64_t)parsed;

  /* The name carries the size, so a stale probe from a previous run with a
   * different size cannot be mistaken for this one's, and a reader of the
   * directory can tell what a leftover file is. */
  char name[CR_NAME_MAX + 1];
  snprintf(name, sizeof name, "cr-clone-probe-%" PRIu64 ".bin", bytes);

  char source_path[CR_PATH_MAX];
  char destination_path[CR_PATH_MAX];
  if (join_probe_path(source_path, sizeof source_path, source_directory, name) != 0
    || join_probe_path(destination_path, sizeof destination_path, destination_directory, name) != 0) {
    printf("errno %d\n", EINVAL);
    return 0;
  }

  /* Remove leftovers from a previous run of this program. Both names are this
   * program's own, so unlinking them cannot touch anything a caller owns. */
  (void)unlink(source_path);
  (void)unlink(destination_path);

  int written = write_probe_file(source_path, bytes);
  if (written != 0) {
    printf("errno %d\n", written);
    return 0;
  }

  errno = 0;
  int result = clonefile(source_path, destination_path, CR_CLONE_NOFOLLOW);
  int saved = errno;

  (void)unlink(source_path);
  if (result == 0) {
    (void)unlink(destination_path);
    printf("ok %" PRIu64 "\n", bytes);
  } else {
    /* clonefile(2) returns -1 and sets errno, or a negative errno directly on
     * some builds. Both shapes are reduced to the positive errno the caller
     * classifies, and anything that is not one is reported as EINVAL rather
     * than guessed at. */
    int code = (result == -1) ? saved : (-result);
    printf("errno %d\n", code > 0 ? code : EINVAL);
  }
  return 0;
}