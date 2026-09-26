/* Disposable native fixture only. No network, credentials or real agent. */
#include <fcntl.h>
#include <signal.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  const char *expected[] = { "--print", "--output-format", "stream-json", "--verbose", "--restricted",
    "--bare", "--disallowedTools", "*,mcp__*", "--permission-prompts", "none", "--no-session-persistence",
    "--max-turns", "1", "--model", "opus" };
  if (argc != 16) return 90;
  for (int i = 1; i < argc; i++) if (strcmp(argv[i], expected[i - 1]) != 0) return 91;
  if (getenv("ACR_FIXTURE_MUST_NOT_INHERIT") != NULL || getenv("HOME") != NULL) return 92;
  for (int fd = 3; fd < 128; fd++) if (fcntl(fd, F_GETFD) >= 0) return 93;
  int marker = open("target-started", O_WRONLY | O_CREAT | O_EXCL, 0600);
  if (marker < 0) return 94;
  close(marker);
  if (write(1, "fixture-output\n", 15) != 15 || write(2, "fixture-error\n", 14) != 14) return 95;
  char mode = 0;
  if (read(0, &mode, 1) != 1) return 96;
  if (mode == 'x') return 7;
  if (mode == 'i') signal(SIGTERM, SIG_IGN);
  while (1) pause();
}
