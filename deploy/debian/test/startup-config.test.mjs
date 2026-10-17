import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { confirmedRuntimePath } from '../startup-config.mjs';

test('startup uses last success despite a newer failed or pending candidate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mihomo-startup-'));
  try {
    const bootstrap = join(dir, 'bootstrap.yaml');
    assert.equal(confirmedRuntimePath(bootstrap, dir), bootstrap);
    const content = 'mode: rule\n';
    const version = 'a'.repeat(64);
    const path = join(dir, `${version}.yaml`);
    const generated = { schemaVersion: 1, version, contentSha256: createHash('sha256').update(content).digest('hex') };
    writeFileSync(path, content);
    for (const status of ['pending', 'failed', 'unknown']) {
      writeFileSync(join(dir, 'load-state.json'), JSON.stringify({
        schemaVersion: 1, lastSuccessful: { generated },
        lastAttempt: { status, generated: { ...generated, version: 'b'.repeat(64) } },
      }));
      assert.equal(confirmedRuntimePath(bootstrap, dir), path);
    }
    writeFileSync(path, 'mode: direct\n');
    assert.throws(() => confirmedRuntimePath(bootstrap, dir));
    rmSync(path);
    assert.throws(() => confirmedRuntimePath(bootstrap, dir));
    writeFileSync(join(dir, 'load-state.json'), JSON.stringify({ schemaVersion: 1, lastSuccessful: null }));
    assert.throws(() => confirmedRuntimePath(bootstrap, dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
