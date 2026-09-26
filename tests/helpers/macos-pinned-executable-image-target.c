#include <fcntl.h>
#include <string.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc == 2 && argv[1] != NULL) {
    int fd = open(argv[1], O_WRONLY | O_CREAT | O_EXCL, 0600);
    if (fd >= 0) {
#ifdef ACR_ALTERNATE
      const char marker[] = "substitute-target-ran\n";
#else
      const char marker[] = "target-ran\n";
#endif
      (void)write(fd, marker, strlen(marker));
      close(fd);
    }
  }
  return 0;
}
