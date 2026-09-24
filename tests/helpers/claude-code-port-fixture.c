/* Disposable adapter fixture: fixed-argv validation is covered by the shared
 * native fixture. These modes exercise cleanup without any real agent. */
#include <signal.h>
#include <stdlib.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/types.h>

int main(void) {
  char mode = 0;
  if (read(0, &mode, 1) != 1) return 91;
  if (mode == 'x') {
    if (write(1, "ACRS forged target output\n", sizeof("ACRS forged target output\n") - 1) < 0
        || write(2, "private fixture error\n", sizeof("private fixture error\n") - 1) < 0) return 92;
    return 7;
  }
  if (mode == 'i') {
    signal(SIGTERM, SIG_IGN);
    if (write(1, "ready\n", 6) < 0) return 93;
    while (1) pause();
  }
  if (mode == 'd') {
    pid_t child = fork();
    if (child < 0) return 94;
    if (child == 0) { while (1) pause(); }
    return 11;
  }
  if (mode == 'h') {
    /* Self-retiring fixture deliberately kills its helper. This proves the
     * port reports uncertainty; it is not helper-death recovery evidence. */
    if (kill(getppid(), SIGKILL) != 0) return 95;
    usleep(150000);
    return 12;
  }
  if (mode == 'a') {
    /* Kill only the process-group leader (the private anchor), then leave
     * evidence if supervisor recovery fails to retire this target. */
    if (kill(getpgrp(), SIGKILL) != 0) return 96;
    usleep(500000);
    int marker = open("anchor-target-survived", O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (marker >= 0) close(marker);
    while (1) pause();
  }
  while (1) pause();
}
