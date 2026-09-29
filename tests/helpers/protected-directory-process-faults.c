/* Untrusted process-output fixtures for the wrapper; no filesystem effects. */
#include <stdio.h>
#include <unistd.h>
#include <fcntl.h>
#include <stdint.h>
#include <string.h>
#ifndef FAULT
#error "select an explicit test fault"
#endif
int main(void) {
  unsigned char request[8192];
  size_t total = 0;
  ssize_t count;
  while (total < sizeof(request) && (count = read(0, request + total, sizeof(request) - total)) > 0) total += (size_t)count;
#if FAULT == 1
  (void)write(1, "unexpected private material", 27);
#elif FAULT == 2
  for (;;) pause();
#elif FAULT == 3
  unsigned char large[4096] = { 0 };
  (void)write(1, large, sizeof(large));
#elif FAULT == 4
  (void)write(2, "private detail", 14);
#elif FAULT == 5
  if (total >= 48) {
    uint32_t length = ((uint32_t)request[8] << 24) | ((uint32_t)request[9] << 16)
      | ((uint32_t)request[10] << 8) | request[11];
    if (length < 4096 && total >= 48 + length) {
      char marker[4200];
      memcpy(marker, request + 48, length);
      strcpy(marker + length, "/attacker-executed");
      int fd = open(marker, O_WRONLY | O_CREAT | O_EXCL, 0600);
      if (fd >= 0) close(fd);
    }
  }
  return 91;
#elif FAULT == 6
  (void)write(1, "ACRDIR1 ", 8);
#else
#error "unknown test fault"
#endif
  return 0;
}
