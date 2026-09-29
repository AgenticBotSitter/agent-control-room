/* Production algorithm with transport fragmentation; never release-built. */
#include <unistd.h>
static ssize_t fragmented_write(int fd, const void *bytes, size_t count);
#define write fragmented_write
#include "../../native/protected-directory-v1.c"
#undef write
static ssize_t fragmented_write(int fd, const void *bytes, size_t count) {
  if (fd != STDOUT_FILENO) return write(fd, bytes, count);
  const unsigned char *input = bytes;
  for (size_t index = 0; index < count; index++) {
    if (write(fd, input + index, 1) != 1) return -1;
    usleep(1000);
  }
  return (ssize_t)count;
}
