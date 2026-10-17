import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, normalize, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const defaultAccessDirectory = '/var/lib/mihomo-manager/access';

function accessDirectory(value) {
    if (!isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value) || normalize(value) === '/') {
        throw new Error('ACCESS_DATA_DIR must be a dedicated absolute directory.');
    }
    return normalize(value);
}

export function readAccessDirectory(environment) {
    const values = readFileSync(environment, 'utf8').split(/\r?\n/)
        .map(line => /^[ \t]*ACCESS_DATA_DIR[ \t]*=(.*)$/.exec(line)).filter(Boolean);
    if (!values.length) return defaultAccessDirectory;
    let value = values.at(-1)[1].trim();
    if (value.startsWith("'")) {
        if (!/^'[^']*'$/.test(value)) throw new Error('ACCESS_DATA_DIR must use a single-line value.');
        value = value.slice(1, -1);
    } else if (value.startsWith('"')) {
        if (!/^"(?:[^"\\]|\\.)*"$/.test(value)) throw new Error('ACCESS_DATA_DIR must use a single-line value.');
        value = value.slice(1, -1).replace(/\\(["\\$\x60])/g, '$1');
    } else {
        if (value.endsWith('\\')) throw new Error('ACCESS_DATA_DIR must use a single-line value.');
        value = value.replace(/\\(.)/g, '$1');
    }
    return accessDirectory(value);
}

export function prepareAccessDirectory(directory) {
    execFileSync('/usr/bin/install', ['-d', '-o', 'mihomo-manager', '-g', 'mihomo-manager', '-m', '700', accessDirectory(directory)]);
}

export function writeAccessPermissions(directory, output) {
    const value = accessDirectory(directory).replaceAll('%', '%%');
    execFileSync('/usr/bin/install', ['-d', '-o', 'root', '-g', 'root', '-m', '755', dirname(output)]);
    writeFileSync(output + '.tmp', '[Service]\nReadWritePaths=' + JSON.stringify(value) + '\n', { mode: 0o644 });
    renameSync(output + '.tmp', output);
}

export function assertAccessCompatible(directory, target) {
    directory = accessDirectory(directory);
    let enabled = false;
    try {
        const value = JSON.parse(readFileSync(directory + '/settings.json', 'utf8'));
        if (value.version !== 1 || typeof value.enabled !== 'boolean' || (value.enabled
            ? !value.password || !/^[a-f0-9]{64}$/.test(value.password.salt) || !/^[a-f0-9]{128}$/.test(value.password.hash)
            : value.password !== null)) throw new Error();
        enabled = value.enabled;
    } catch (error) {
        if (error.code !== 'ENOENT' || existsSync(directory + '/.initialized')) {
            throw new Error('Access settings must be restored before changing the program.');
        }
    }
    if (enabled && !existsSync(target + '/sysinfo/dist/access/http.js')) {
        throw new Error('The target program must support the enabled website authentication.');
    }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
    const [action, first, second] = process.argv.slice(2);
    switch (action) {
        case 'directory': console.log(readAccessDirectory(first)); break;
        case 'prepare': prepareAccessDirectory(first); break;
        case 'permissions': writeAccessPermissions(first, second); break;
        case 'compatible': assertAccessCompatible(first, second); break;
        default: throw new Error('Expected directory, prepare, permissions or compatible.');
    }
}
