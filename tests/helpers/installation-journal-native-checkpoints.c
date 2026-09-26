/* Apache-2.0 test harness: expose exact helper checkpoints on fd 3/4. */
#include <stdint.h>
#include <unistd.h>
static void journal_checkpoint(uint32_t phase, int root_fd, const char *name) {
  (void)root_fd; (void)name;
  unsigned char bytes[4] = { (unsigned char)(phase >> 24), (unsigned char)(phase >> 16),
    (unsigned char)(phase >> 8), (unsigned char)phase }, acknowledgement;
  if (write(3, bytes, sizeof(bytes)) != (ssize_t)sizeof(bytes) || read(4, &acknowledgement, 1) != 1) _exit(91);
}
#define ACR_JOURNAL_CHECKPOINT(phase, root_fd, name) journal_checkpoint((phase), (root_fd), (name))
#include "../../native/installation-journal-session-v1.c"
