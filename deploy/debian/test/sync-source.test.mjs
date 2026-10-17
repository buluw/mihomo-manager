import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { removedSources, syncManagerSource } from "../sync-source.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "mihomo-source-sync-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "source"), app = join(root, "app"), data = join(root, "data");
  for (const dir of [source, app, data]) mkdirSync(dir);
  const put = (base, path, value) => { const file = join(base, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value); };
  return { root, source, app, data, put };
}

test("source sync removes only approved files and preserves dependencies, data and unrelated sources", t => {
  const { source, app, data, put } = fixture(t);
  for (const file of removedSources) put(app, file, "obsolete");
  put(source, "frontend/src/current.ts", "updated");
  put(app, "frontend/src/unlisted-old.ts", "retained");
  for (const path of ["frontend/node_modules/fixture", "frontend/.dependencies.sha256", "frontend/dist/fixture"]) {
    put(app, path, "retained"); put(source, path, "excluded");
  }
  put(data, "config.yaml", "retained");
  assert.equal(syncManagerSource(source, app), 6);
  assert.equal(syncManagerSource(source, app), 0);
  for (const file of removedSources) assert.equal(existsSync(join(app, file)), false);
  assert.equal(readFileSync(join(app, "frontend/src/current.ts"), "utf8"), "updated");
  for (const path of ["frontend/src/unlisted-old.ts", "frontend/node_modules/fixture", "frontend/.dependencies.sha256", "frontend/dist/fixture"]) {
    assert.equal(readFileSync(join(app, path), "utf8"), "retained");
  }
  assert.equal(readFileSync(join(data, "config.yaml"), "utf8"), "retained");
});

test("source sync rejects conflicting archives before any update or deletion", t => {
  const { source, app, put } = fixture(t);
  put(app, removedSources[0], "retained");
  put(source, removedSources[1], "conflicting");
  put(source, "frontend/src/current.ts", "new");
  assert.throws(() => syncManagerSource(source, app), /still exists/);
  assert.equal(readFileSync(join(app, removedSources[0]), "utf8"), "retained");
  assert.equal(existsSync(join(app, "frontend/src/current.ts")), false);
});

test("approved deletions reject symlink parents and non-file targets", t => {
  const { source, app, data, put } = fixture(t);
  put(data, "useProviderSource.ts", "retained");
  mkdirSync(join(app, "frontend/src/features"), { recursive: true });
  symlinkSync(data, join(app, "frontend/src/features/providers"));
  assert.throws(() => syncManagerSource(source, app), /escaped/);
  assert.equal(readFileSync(join(data, "useProviderSource.ts"), "utf8"), "retained");
  rmSync(join(app, "frontend/src/features/providers"));
  mkdirSync(join(app, removedSources[0]), { recursive: true });
  assert.throws(() => syncManagerSource(source, app), /regular file/);
});
