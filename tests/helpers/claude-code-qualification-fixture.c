#include <stdio.h>
#include <string.h>

int main(void) {
  static const char prefix[] = "Reply with exactly this text and nothing else: ";
  char input[512] = {0};
  size_t length = fread(input, 1, sizeof(input) - 1, stdin);
  input[length] = '\0';
  if (length <= sizeof(prefix) - 1 || strncmp(input, prefix, sizeof(prefix) - 1) != 0) return 4;
  char *nonce = input + sizeof(prefix) - 1;
  nonce[strcspn(nonce, "\r\n")] = '\0';
  if (!nonce[0]) return 5;
  puts("{\"type\":\"system\",\"subtype\":\"init\",\"session_id\":\"00000000-0000-4000-8000-000000004242\"}");
  printf("{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"session_id\":\"00000000-0000-4000-8000-000000004242\",\"result\":\"%s\",\"usage\":{\"input_tokens\":3,\"output_tokens\":2,\"total_tokens\":5}}\n", nonce);
  return 0;
}
