import qrcode from "qrcode-generator";
import { updaterRefuseV1 } from "../contracts.mjs";

const hostPattern = /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u;
const secretPattern = /^[A-Za-z0-9_-]{16,512}$/u;
const refuse = code => { throw updaterRefuseV1(code); };

export function initialPasskeyUrlV1({ rpId, ownerCode, registrationSecret }) {
  if (!hostPattern.test(rpId ?? "") || !secretPattern.test(ownerCode ?? "")
    || !secretPattern.test(registrationSecret ?? "")) refuse("passkey_registration_url_refused");
  const fragment = new URLSearchParams({ code: ownerCode, reg: registrationSecret });
  return `https://${rpId}/setup#${fragment.toString()}`;
}

export function createQrMatrixV1(value) {
  if (typeof value !== "string" || value.length < 1 || Buffer.byteLength(value) > 2048) refuse("passkey_qr_refused");
  try {
    const qr = qrcode(0, "M"); qr.addData(value, "Byte"); qr.make();
    const size = qr.getModuleCount();
    return Object.freeze(Array.from({ length: size }, (_, row) => Object.freeze(
      Array.from({ length: size }, (_, column) => qr.isDark(row, column)))));
  } catch { refuse("passkey_qr_refused"); }
}

export function terminalQrTextV1(value, quietZone = 2) {
  if (!Number.isSafeInteger(quietZone) || quietZone < 2 || quietZone > 8) refuse("passkey_qr_refused");
  const matrix = createQrMatrixV1(value), size = matrix.length, lines = [];
  const dark = (row, column) => row >= 0 && row < size && column >= 0 && column < size && matrix[row][column];
  for (let row = -quietZone; row < size + quietZone; row += 2) {
    let line = "";
    for (let column = -quietZone; column < size + quietZone; column += 1) {
      const upper = dark(row, column), lower = dark(row + 1, column);
      line += upper ? (lower ? "█" : "▀") : (lower ? "▄" : " ");
    }
    lines.push(line);
  }
  return `${lines.join("\n")}\n`;
}

export function renderInitialPasskeyV1(input, terminal) {
  if (!terminal || typeof terminal.write !== "function") refuse("passkey_terminal_required");
  const url = initialPasskeyUrlV1(input);
  terminal.write(terminalQrTextV1(url));
  terminal.write(`Open this address if you cannot scan the QR code:\n${url}\n`);
  return Object.freeze({ mode: "initial", url });
}
