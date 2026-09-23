/* Disposable adapter fixture: fixed-argv validation is covered by the shared
 * native fixture. These modes exercise cleanup without any real agent. */
#include <signal.h>
#include <stdlib.h>
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
  while (1) pause();
}
