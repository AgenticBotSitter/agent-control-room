/* Untrusted-status fake for adapter parser tests only. No target is spawned. */
#include <stdint.h>
#include <string.h>
#include <unistd.h>

static int exact(unsigned char *out, size_t size) {
  size_t offset = 0;
  while (offset < size) { ssize_t got = read(0, out + offset, size - offset); if (got <= 0) return -1; offset += (size_t)got; }
  return 0;
}
static uint32_t u32(const unsigned char *p) {
  return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}
static int frame(unsigned char *bytes) {
  for (size_t i = 0; i < 16; i++) { if (write(1, bytes + i, 1) != 1) return -1; usleep(1000); }
  return 0;
}
int main(void) {
  unsigned char header[104], paths[8192], control[16];
  if (exact(header, sizeof(header)) != 0) return 1;
  uint32_t size = u32(header + 12) + u32(header + 16);
  if (size >= sizeof(paths) || exact(paths, size) != 0) return 1;
  paths[size] = 0;
  unsigned char status[16] = { 'A', 'C', 'R', 'S', 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 };
  if (strstr((char *)paths, "bad-header")) status[7] = 1;
  if (frame(status) != 0 || exact(control, sizeof(control)) != 0) return 1;
  status[4] = 2; if (frame(status) != 0) return 1;
  status[4] = 3; status[5] = 1; status[6] = 1;
  if (strstr((char *)paths, "bad-exit")) status[6] = 0;
  if (frame(status) != 0) return 1;
  if (strstr((char *)paths, "extra-frame")) { status[4] = 1; (void)frame(status); }
  if (strstr((char *)paths, "truncated")) (void)write(1, "AC", 2);
  return 0;
}
