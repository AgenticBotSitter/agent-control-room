#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#ifndef FAULT_MODE
#define FAULT_MODE 0
#endif

#if FAULT_MODE == 1 || FAULT_MODE == 6
static void ignore_signal(int signal_number) { (void)signal_number; }
#endif

int main(void) {
#if FAULT_MODE == 1
  signal(SIGTERM, ignore_signal);
  for (;;) pause();
#elif FAULT_MODE == 2
  static const char message[] = "private-material-must-not-escape\n";
  (void)write(STDERR_FILENO, message, sizeof(message) - 1);
  return 0;
#elif FAULT_MODE == 3
  char output[512]; memset(output, 'x', sizeof(output));
  (void)write(STDOUT_FILENO, output, sizeof(output));
  return 0;
#elif FAULT_MODE == 4
  (void)write(STDOUT_FILENO, "ACRCFG1 malformed\n", 18);
  return 0;
#elif FAULT_MODE == 5
  return 17;
#elif FAULT_MODE == 6
  signal(SIGTERM, ignore_signal);
  signal(SIGINT, ignore_signal);
  pid_t child = fork();
  if (child < 0) return 19;
  if (child == 0) for (;;) pause();
  char readiness[128];
  int length = snprintf(readiness, sizeof(readiness), "READY %d %d %d\n",
    (int)getpid(), (int)child, (int)getpgrp());
  if (length < 1 || (size_t)length >= sizeof(readiness)
      || write(STDOUT_FILENO, readiness, (size_t)length) != length) return 29;
  for (;;) pause();
#else
  return 23;
#endif
}
