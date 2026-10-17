import { existsSync, readFileSync } from 'node:fs';
const lines = readFileSync('/etc/mihomo-manager/manager.env', 'utf8').split(/\r?\n/);
const setting = (key, fallback) => lines.findLast(line => line.startsWith(key + '='))?.slice(key.length + 1).trim().replace(/^(["'])(.*)\1$/, '$2') ?? fallback;
const base = 'http://127.0.0.1:9090';
const paths = ['/api/controller/version', '/api/config/manager-settings', '/api/system/interfaces', '/api/logs/health'];
const secret = setting('MIHOMO_CONTROLLER_SECRET', '');
async function probe(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(2000) });
  await response.arrayBuffer();
  return response;
}
for (let attempt = 0; attempt < 30; attempt++) {
  try {
    const status = await fetch(base + '/api/access/status', { signal: AbortSignal.timeout(2000) });
    let enabled = null;
    if (status.ok && status.headers.get('content-type')?.includes('application/json')) enabled = (await status.json()).enabled;
    else if (status.status === 404 || status.ok) {
      const directory = setting('ACCESS_DATA_DIR', '/var/lib/mihomo-manager/access');
      if (existsSync(directory + '/settings.json')) {
        const settings = JSON.parse(readFileSync(directory + '/settings.json', 'utf8'));
        if (settings.version !== 1 || settings.enabled !== false || settings.password !== null) throw new Error();
      } else if (existsSync(directory + '/.initialized')) throw new Error();
      enabled = false;
    }
    if (typeof enabled !== 'boolean') throw new Error();
    const responses = await Promise.all(paths.map(path => probe(base + path, secret && path.includes('/controller/') ? { Authorization: 'Bearer ' + secret } : {})));
    if (!responses.every(response => enabled ? response.status === 401 && response.headers.get('x-access-state') === 'required' : response.ok)) throw new Error();
    if (enabled) {
      const targets = [
        [setting('MIHOMO_CONTROLLER_URL', 'http://127.0.0.1:19090') + '/version', secret ? { Authorization: 'Bearer ' + secret } : {}],
        ['http://' + setting('CONFIGD_HOST', '127.0.0.1') + ':' + setting('CONFIGD_PORT', '9081') + '/manager-settings', {}],
        ['http://' + setting('LOGD_HOST', '127.0.0.1') + ':' + setting('LOGD_PORT', '9082') + '/health', {}],
      ];
      if (!(await Promise.all(targets.map(([url, headers]) => probe(url, headers)))).every(response => response.ok)) throw new Error();
    }
    process.exit(0);
  } catch { /* Report status only; credentials and request details stay private. */ }
  await new Promise(resolve => setTimeout(resolve, 1000));
}
console.error('Manager HTTP health checks did not pass.');
process.exit(1);
