#define _DARWIN_C_SOURCE
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/types.h>
#include <unistd.h>

#define HEADER_BYTES 120U
#define RESPONSE_BYTES 96U
#ifndef ACR_FIXTURE_READY_PATH
#define ACR_FIXTURE_READY_PATH "/private/tmp/acr-service-fixture-ready"
#endif

static uint32_t u32(const unsigned char *p) {
  return ((uint32_t)p[0] << 24) | ((uint32_t)p[1] << 16) | ((uint32_t)p[2] << 8) | p[3];
}
static void put32(unsigned char *p, uint32_t value) {
  p[0] = (unsigned char)(value >> 24); p[1] = (unsigned char)(value >> 16);
  p[2] = (unsigned char)(value >> 8); p[3] = (unsigned char)value;
}
static int read_exact(unsigned char *bytes, size_t length) {
  size_t offset = 0;
  while (offset < length) {
    ssize_t count = read(STDIN_FILENO, bytes + offset, length - offset);
    if (count <= 0) return -1;
    offset += (size_t)count;
  }
  return 0;
}
static int ignore_termination(void) {
  return signal(SIGTERM, SIG_IGN) != SIG_ERR && signal(SIGINT, SIG_IGN) != SIG_ERR
    && signal(SIGHUP, SIG_IGN) != SIG_ERR;
}
static void pause_forever(void) {
  for (;;) pause();
}
static void hang_forever(void) {
  if (!ignore_termination()) _exit(6);
  pause_forever();
}
static int acknowledge_ready(pid_t descendant) {
  char bytes[128];
  int length = snprintf(bytes, sizeof(bytes), "%ld %ld %ld\n", (long)getpid(), (long)descendant, (long)getpgrp());
  if (length < 1 || (size_t)length >= sizeof(bytes)) return -1;
  int fd = open(ACR_FIXTURE_READY_PATH, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0600);
  if (fd < 0) return -1;
  int valid = write(fd, bytes, (size_t)length) == (ssize_t)length && fsync(fd) == 0;
  close(fd); return valid ? 0 : -1;
}

int main(void) {
  unsigned char header[HEADER_BYTES], response[RESPONSE_BYTES], discarded[4096];
  if (read_exact(header, sizeof(header)) != 0 || memcmp(header, "ACRSVC1\n", 8) != 0) return 2;
  while (read(STDIN_FILENO, discarded, sizeof(discarded)) > 0) {}
  uint32_t operation = u32(header + 12);
  if (operation == 4U) {
    if (!ignore_termination()) return 6;
    pid_t descendant = fork();
    if (descendant < 0) return 3;
    if (descendant == 0) {
      close(STDIN_FILENO); close(STDOUT_FILENO); close(STDERR_FILENO);
      pause_forever();
    }
    if (acknowledge_ready(descendant) != 0) return 5;
    pause_forever();
  }
  if (operation == 2U) {
    pid_t descendant = fork();
    if (descendant < 0) return 3;
    if (descendant == 0) {
      close(STDIN_FILENO); close(STDOUT_FILENO); close(STDERR_FILENO);
      hang_forever();
    }
  }
  memset(response, 0, sizeof(response));
  memcpy(response, "ACRSVR1\n", 8); put32(response + 8, 1U); put32(response + 12, 1U);
  memcpy(response + 16, header + 32, 16);
  if (operation == 5U) response[95] = 1U;
  return write(STDOUT_FILENO, response, sizeof(response)) == (ssize_t)sizeof(response) ? 0 : 4;
}
