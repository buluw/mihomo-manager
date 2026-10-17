import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function confirmedRuntimePath(bootstrapPath, runtimeDir) {
  const statePath = join(runtimeDir, 'load-state.json');
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return bootstrapPath;
    throw new Error('The runtime load record is unreadable.');
  }
  const generated = state.lastSuccessful?.generated;
  if (state.schemaVersion !== 1 || generated?.schemaVersion !== 1
      || !/^[a-f0-9]{64}$/.test(generated.version)
      || !/^[a-f0-9]{64}$/.test(generated.contentSha256)) {
    throw new Error('No confirmed generated runtime configuration is available.');
  }
  const path = join(runtimeDir, `${generated.version}.yaml`);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()
      || createHash('sha256').update(readFileSync(path)).digest('hex') !== generated.contentSha256) {
    throw new Error('The confirmed generated runtime configuration has changed.');
  }
  return path;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { MIHOMO_BOOTSTRAP_PATH, CONFIGD_RUNTIME_DIR } = process.env;
    if (!MIHOMO_BOOTSTRAP_PATH || !CONFIGD_RUNTIME_DIR) throw new Error();
    process.stdout.write(confirmedRuntimePath(MIHOMO_BOOTSTRAP_PATH, CONFIGD_RUNTIME_DIR));
  } catch {
    process.stderr.write('Cannot select a verified startup configuration.\n');
    process.exitCode = 1;
  }
}
