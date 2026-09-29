/*
 * ACRHNL1 fixture custodian.  This accepts precisely one already-captured
 * Hermes launch-custody frame, but deliberately has no launch operation.
 * It does not inspect paths, environment, credentials, profiles, models,
 * providers, working directories, databases, or protected storage.
 */
#ifndef __APPLE__
#error "hermes-native-launch-custodian-v1 requires macOS"
#endif
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdint.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define FRAME_BYTES 280U
#define HEADER_BYTES 24U
#define DIGEST_COUNT 8U
#define DEADLINE_MS UINT64_C(1000)
#define RESPONSE_BYTES 16U

static volatile sig_atomic_t cancelled;
static uint64_t deadline;

static void cancel(int signal_number) { (void)signal_number; cancelled = 1; }
static uint64_t now_ms(void) {
  struct timespec value;
  if (clock_gettime(CLOCK_MONOTONIC, &value) != 0 || value.tv_sec < 0) return 0;
  return (uint64_t)value.tv_sec * 1000U + (uint64_t)value.tv_nsec / 1000000U;
}
static int active(void) { uint64_t now = now_ms(); return !cancelled && now != 0 && now < deadline; }
static uint32_t u32(const unsigned char *bytes) {
  return ((uint32_t)bytes[0] << 24) | ((uint32_t)bytes[1] << 16)
    | ((uint32_t)bytes[2] << 8) | bytes[3];
}
static int read_exact(unsigned char *bytes, size_t length) {
  size_t offset = 0;
  while (offset < length && active()) {
    uint64_t now = now_ms();
    if (now == 0 || now >= deadline) return -1;
    struct pollfd input = { .fd = STDIN_FILENO, .events = POLLIN, .revents = 0 };
    int ready = poll(&input, 1, (int)(deadline - now));
    if (ready < 0 && errno == EINTR) continue;
    if (ready <= 0 || (input.revents & (POLLERR | POLLNVAL))
        || ((input.revents & POLLHUP) && !(input.revents & POLLIN))) return -1;
    ssize_t received = read(STDIN_FILENO, bytes + offset, length - offset);
    if (received < 0 && errno == EINTR) continue;
    if (received <= 0) return -1;
    offset += (size_t)received;
  }
  return offset == length && active() ? 0 : -1;
}
/* A custody frame is the complete input stream, not merely its first 280 bytes. */
static int require_eof(void) {
  while (active()) {
    uint64_t now = now_ms();
    if (now == 0 || now >= deadline) return -1;
    struct pollfd input = { .fd = STDIN_FILENO, .events = POLLIN, .revents = 0 };
    int ready = poll(&input, 1, (int)(deadline - now));
    if (ready < 0 && errno == EINTR) continue;
    if (ready <= 0 || (input.revents & (POLLERR | POLLNVAL))) return -1;
    if (input.revents & (POLLIN | POLLHUP)) {
      unsigned char extra;
      ssize_t received = read(STDIN_FILENO, &extra, 1);
      if (received < 0 && errno == EINTR) continue;
      return received == 0 ? 0 : -1;
    }
    return -1;
  }
  return -1;
}
static int valid_frame(const unsigned char *frame) {
  if (memcmp(frame, "ACRHNL1\n", 8) != 0 || (frame[8] != 1 && frame[8] != 2)
      || frame[9] != 0 || frame[10] != 0 || frame[11] != 0
      || u32(frame + 12) != FRAME_BYTES || u32(frame + 16) != DIGEST_COUNT
      || frame[20] != 0 || frame[21] != 0 || frame[22] != 0 || frame[23] != 0) return 0;
  for (size_t index = HEADER_BYTES; index < FRAME_BYTES; index++) if (frame[index] != 0) return 1;
  return 0;
}
/* No process is ever created, so all requested retirement is refused. */
static int reply_inert_cleanup_refused(void) {
  const unsigned char response[RESPONSE_BYTES] = {
    'A','C','R','S', 1, 4, 1, 0, 0,0,0,1, 0,0,0,0
  };
  size_t offset = 0;
  int flags = fcntl(STDOUT_FILENO, F_GETFL);
  if (flags < 0 || fcntl(STDOUT_FILENO, F_SETFL, flags | O_NONBLOCK) != 0) return -1;
  while (offset < sizeof(response) && active()) {
    uint64_t now = now_ms();
    if (now == 0 || now >= deadline) return -1;
    struct pollfd output = { .fd = STDOUT_FILENO, .events = POLLOUT, .revents = 0 };
    int ready = poll(&output, 1, (int)(deadline - now));
    if (ready < 0 && errno == EINTR) continue;
    if (ready <= 0 || (output.revents & (POLLERR | POLLHUP | POLLNVAL))
        || !(output.revents & POLLOUT)) return -1;
    ssize_t written = write(STDOUT_FILENO, response + offset, sizeof(response) - offset);
    if (written < 0 && errno == EINTR) continue;
    if (written < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) continue;
    if (written <= 0) return -1;
    offset += (size_t)written;
  }
  return offset == sizeof(response) && active() ? 0 : -1;
}
int main(void) {
  unsigned char frame[FRAME_BYTES]; uint64_t now = now_ms();
  if (now == 0 || now > UINT64_MAX - DEADLINE_MS) return 70;
  deadline = now + DEADLINE_MS;
  if (signal(SIGINT, cancel) == SIG_ERR || signal(SIGTERM, cancel) == SIG_ERR) return 70;
  if (signal(SIGPIPE, SIG_IGN) == SIG_ERR) return 70;
  if (read_exact(frame, sizeof(frame)) != 0) return cancelled ? 69 : 68;
  if (!valid_frame(frame)) return 67;
  if (require_eof() != 0) return cancelled ? 69 : 68;
  return reply_inert_cleanup_refused() == 0 ? 0 : 70;
}
