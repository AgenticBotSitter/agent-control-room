import { isIP } from "node:net";

function parseIpv4(address: string) {
  if (isIP(address) !== 4) return null;
  const octets = address.split(".").map(Number);
  return octets.length === 4 ? octets : null;
}

function parseIpv6(address: string) {
  const withoutZone = address.split("%", 1)[0].toLowerCase();
  if (isIP(withoutZone) !== 6) return null;

  let normalized = withoutZone;
  const ipv4Start = normalized.lastIndexOf(":");
  if (normalized.includes(".")) {
    const ipv4 = parseIpv4(normalized.slice(ipv4Start + 1));
    if (!ipv4) return null;
    normalized = `${normalized.slice(0, ipv4Start)}:${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const words = [
    ...left,
    ...Array.from({ length: halves.length === 2 ? missing : 0 }, () => "0"),
    ...right,
  ].map((word) => Number.parseInt(word || "0", 16));
  return words.length === 8 && words.every((word) => Number.isInteger(word) && word >= 0 && word <= 0xffff)
    ? words
    : null;
}

function isNonPublicIpv4(octets: number[]) {
  const [first, second, third, fourth] = octets;
  if (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 192 && second === 0 && third === 2) ||
    (first === 192 && second === 88 && third === 99) ||
    (first === 198 && (second === 18 || second === 19)) ||
    (first === 198 && second === 51 && third === 100) ||
    (first === 203 && second === 0 && third === 113) ||
    first >= 224
  ) return true;

  // Most of 192.0.0.0/24 is special-purpose. These two anycast addresses are
  // the only globally reachable exceptions in that block.
  return first === 192 && second === 0 && third === 0 && fourth !== 9 && fourth !== 10;
}

function embeddedIpv4(words: number[], start: number) {
  return [
    words[start] >> 8,
    words[start] & 0xff,
    words[start + 1] >> 8,
    words[start + 1] & 0xff,
  ];
}

export function isNonPublicIpAddress(address: string) {
  const normalized = address.replace(/^\[|\]$/g, "");
  const ipv4 = parseIpv4(normalized);
  if (ipv4) return isNonPublicIpv4(ipv4);

  const words = parseIpv6(normalized);
  if (!words) return true;

  const firstFiveAreZero = words.slice(0, 5).every((word) => word === 0);
  if (firstFiveAreZero && words[5] === 0xffff)
    return isNonPublicIpv4(embeddedIpv4(words, 6));

  const isWellKnownNat64 =
    words[0] === 0x0064 &&
    words[1] === 0xff9b &&
    words.slice(2, 6).every((word) => word === 0);
  if (isWellKnownNat64)
    return isNonPublicIpv4(embeddedIpv4(words, 6));

  // Current globally routable unicast IPv6 space is 2000::/3. Fail closed for
  // every other family unless it was one of the explicit embeddings above.
  if ((words[0] & 0xe000) !== 0x2000) return true;

  return (
    (words[0] === 0x2001 && (words[1] & 0xfe00) === 0) || // IETF special-purpose 2001::/23
    (words[0] === 0x2001 && words[1] === 0x0db8) || // documentation 2001:db8::/32
    (words[0] === 0x3fff && (words[1] & 0xf000) === 0) || // documentation 3fff::/20
    words[0] === 0x2002 // deprecated 6to4 transition space
  );
}
