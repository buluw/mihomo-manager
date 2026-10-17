import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { assertAccessCompatible, defaultAccessDirectory, readAccessDirectory } from '../access-deployment.mjs';

test('deployment resolves the configured single-line directory and the absent-key default', t => {
    const root = mkdtempSync(join(tmpdir(), 'access-deployment-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const environment = join(root, 'manager.env');
    const parse = value => { writeFileSync(environment, value); return readAccessDirectory(environment); };
    assert.equal(parse('# ACCESS_DATA_DIR=/unused\nSYSINFO_PORT=9083\n'), defaultAccessDirectory);
    const custom = join(root, 'access custom %d');
    assert.equal(parse('ACCESS_DATA_DIR=/old\n  ACCESS_DATA_DIR="' + custom + '"\n'), custom);
    assert.equal(parse("ACCESS_DATA_DIR='" + custom + "'\n"), custom);
    assert.equal(parse('ACCESS_DATA_DIR=' + custom.replaceAll(' ', '\\ ') + '\n'), custom);
    for (const value of ['', 'relative', '/', '"/unfinished', '/path\\']) {
        assert.throws(() => parse('ACCESS_DATA_DIR=' + value + '\n'));
    }
});

test('compatibility reads the selected directory and preserves initialized credential protection', t => {
    const root = mkdtempSync(join(tmpdir(), 'access-compatibility-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const directory = join(root, 'auth'), target = join(root, 'program');
    mkdirSync(directory); mkdirSync(target);
    assert.doesNotThrow(() => assertAccessCompatible(directory, target));
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({ version: 1, enabled: false, password: null }));
    assert.doesNotThrow(() => assertAccessCompatible(directory, target));
    writeFileSync(join(directory, 'settings.json'), JSON.stringify({ version: 1, enabled: true, password: { salt: '1'.repeat(64), hash: '2'.repeat(128) } }));
    assert.throws(() => assertAccessCompatible(directory, target), /must support/);
    mkdirSync(join(target, 'sysinfo/dist/access'), { recursive: true });
    writeFileSync(join(target, 'sysinfo/dist/access/http.js'), '');
    assert.doesNotThrow(() => assertAccessCompatible(directory, target));
    writeFileSync(join(directory, '.initialized'), '1\n');
    rmSync(join(directory, 'settings.json'));
    assert.throws(() => assertAccessCompatible(directory, target), /must be restored/);
    writeFileSync(join(directory, 'settings.json'), '{invalid');
    assert.throws(() => assertAccessCompatible(directory, target), /must be restored/);
});
