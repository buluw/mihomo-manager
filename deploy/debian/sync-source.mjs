import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, realpathSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Explicitly reviewed removals; ordinary source synchronization is not a mirror.
export const removedSources = Object.freeze([
  "frontend/src/features/providers/useProviderSource.ts",
  "frontend/src/features/providers/providerSourceSession.ts",
  "frontend/src/features/providers/providerSource.ts",
  "frontend/src/features/config-center/ConfigCollectionImportDialog.tsx",
  "frontend/src/features/system/settingsViewModel.ts",
  "frontend/src/components/ui/dateTime.ts",
]);

export function syncManagerSource(source, app) {
  const root = realpathSync(app);
  if (root !== resolve(app)) throw new Error("Application directory must not be a symlink.");
  const removals = [];
  for (const relative of removedSources) {
    if (existsSync(join(source, relative))) throw new Error("An approved removal still exists in the source archive.");
    const target = join(root, relative);
    const stat = lstatSync(target, { throwIfNoEntry: false });
    if (!stat) continue;
    if (!stat.isFile() || realpathSync(dirname(target)) !== join(root, dirname(relative))) {
      throw new Error("Approved source removal escaped the application directory or is not a regular file.");
    }
    removals.push(target);
  }
  execFileSync("rsync", ["-a", "--exclude=node_modules", "--exclude=dist", "--exclude=.dependencies.sha256",
    `${source}/`, `${root}/`], { stdio: "inherit" });
  for (const target of removals) unlinkSync(target);
  return removals.length;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv.length !== 3) throw new Error("One source archive directory is required.");
  const count = syncManagerSource(resolve(process.argv[2]), "/opt/mihomo-manager/app");
  console.log(`Source synchronized; ${count} approved obsolete files removed.`);
}
