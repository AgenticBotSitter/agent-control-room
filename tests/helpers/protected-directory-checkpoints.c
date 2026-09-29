/* Compile-time race harness. Never compiled into the production artifact. */
static void checkpoint(int phase, int parent, const char *child);
#define ACR_TEST_CHECKPOINT(phase, parent, child) checkpoint(phase, parent, child)
#include "../../native/protected-directory-v1.c"
static void checkpoint(int phase, int parent, const char *child) {
  (void)parent; (void)child;
  unsigned char value = (unsigned char)phase;
  if (write(3, &value, 1) != 1) { cancelled = 1; return; }
  struct pollfd control = { .fd = 4, .events = POLLIN, .revents = 0 };
  if (poll(&control, 1, 5000) <= 0 || read(4, &value, 1) != 1 || value != 1) cancelled = 1;
}
