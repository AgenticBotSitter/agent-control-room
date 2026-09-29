// One shared rule for the pinned CLI version, so the provisioner, the host startup
// check and the re-pin step always record and compare the same string.
export function pinnedVersionLine(stdout) {
  const lines = String(stdout).split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  const version = lines.find(line => /(?:^|\s)(?:v?\d+\.\d+|version\b)/iu.test(line));
  if (!version || version.length > 240 || /[\u0000-\u001f\u007f]/u.test(version))
    throw new Error("executable_version_unrecognized");
  return version;
}
