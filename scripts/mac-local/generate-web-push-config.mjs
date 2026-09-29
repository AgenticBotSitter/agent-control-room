import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import webpush from "web-push";

const [root, subject] = process.argv.slice(2);
if (!isAbsolute(root ?? "") || resolve(root) !== root || !/^mailto:[^\s@]+@[^\s@]+$/.test(subject ?? "")) {
  console.error("Usage: node scripts/mac-local/generate-web-push-config.mjs ABSOLUTE_PROTECTED_ROOT mailto:owner@example.invalid"); process.exitCode = 2;
} else {
  const config = join(root, "config"), target = join(config, "owner-web-push.json"), temporary = `${target}.new-${process.pid}`;
  try {
    const rootStat = await lstat(root); if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o077) !== 0) throw new Error();
    await mkdir(config, { recursive: true, mode: 0o700 }); const configStat = await lstat(config);
    if (!configStat.isDirectory() || configStat.isSymbolicLink() || (configStat.mode & 0o077) !== 0) throw new Error();
    try { await readFile(target); throw new Error("owner_web_push_config_exists"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const keys = webpush.generateVAPIDKeys();
    await writeFile(temporary, `${JSON.stringify({ schema: "control-room.owner-web-push-config/v1", subject, publicKey: keys.publicKey, privateKey: keys.privateKey })}\n`, { mode: 0o600 });
    await chmod(temporary, 0o600); await rename(temporary, target);
    console.log("Owner Web Push keys created in the protected configuration.");
  } catch (error) { try { await unlink(temporary); } catch {} console.error(error instanceof Error ? error.message : "owner_web_push_config_failed"); process.exitCode = 1; }
}
