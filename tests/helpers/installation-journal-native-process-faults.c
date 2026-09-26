/* Apache-2.0 process-host fault fixture. Build with ACR_FAULT_MODE:
 * 1 partial opening reply, 2 hang, 3 unbounded output, 4 crash,
 * 5 valid fragmented open/close, 6 valid close reply followed by bad exit,
 * 7 valid close reply followed by trailing stdout. */
#include <signal.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#ifndef ACR_FAULT_MODE
#define ACR_FAULT_MODE 1
#endif
static int exact_read(unsigned char *bytes, size_t count) {
  while (count) { ssize_t result = read(0, bytes, count); if (result <= 0) return -1; bytes += result; count -= (size_t)result; } return 0;
}
static uint32_t u32(const unsigned char *bytes) {
  return ((uint32_t)bytes[0] << 24) | ((uint32_t)bytes[1] << 16) | ((uint32_t)bytes[2] << 8) | bytes[3];
}
static int fragment(const unsigned char *bytes, size_t count) {
  for (size_t index = 0; index < count; index++) if (write(1, bytes + index, 1) != 1) return -1; return 0;
}
int main(void) {
  unsigned char opening[64], discard[8192], command[44];
  if (ACR_FAULT_MODE == 4) raise(SIGKILL);
  if (ACR_FAULT_MODE == 3) { memset(discard, 'x', sizeof(discard)); for (;;) (void)write(1, discard, sizeof(discard)); }
  if (ACR_FAULT_MODE == 1) { (void)write(1, "ACRS", 4); return 0; }
  if (exact_read(opening, sizeof(opening)) != 0) return 7;
  uint32_t remaining = u32(opening + 12) + u32(opening + 16);
  if (remaining > sizeof(discard) || exact_read(discard, remaining) != 0) return 8;
  if (ACR_FAULT_MODE == 2) { for (;;) pause(); }
  const unsigned char opened[16] = { 'A','C','R','S',0,0,0,0, 0,0,0,0, 0,0,0,0 };
  if (fragment(opened, sizeof(opened)) != 0 || exact_read(command, sizeof(command)) != 0 || command[4] != 11) return 9;
  const unsigned char closed[16] = { 'A','C','R','S',11,0,0,0, 0,0,0,1, 0,0,0,0 };
  if (fragment(closed, sizeof(closed)) != 0) return 10;
  if (ACR_FAULT_MODE == 7 && write(1, "trailing", 8) != 8) return 11;
  return ACR_FAULT_MODE == 6 ? 1 : 0;
}
