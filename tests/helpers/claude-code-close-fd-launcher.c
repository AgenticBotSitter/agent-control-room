#include <unistd.h>

int main(int argc, char **argv) {
  if (argc != 2) return 64;
  close(5);
  char *arguments[] = { argv[1], NULL };
  execv(argv[1], arguments);
  return 65;
}
