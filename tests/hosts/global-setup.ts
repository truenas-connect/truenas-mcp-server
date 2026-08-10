import { chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export default function setup(): void {
  // node-pty's darwin prebuilds ship spawn-helper without its execute bit
  // when installed via yarn, and pty.spawn then dies with "posix_spawnp
  // failed". Linux builds from source and has no spawn-helper.
  if (process.platform !== 'darwin') {
    return;
  }
  const root = fileURLToPath(new URL('../..', import.meta.url));
  for (const arch of ['darwin-arm64', 'darwin-x64']) {
    const helper = join(root, 'node_modules', 'node-pty', 'prebuilds', arch, 'spawn-helper');
    if (existsSync(helper)) {
      chmodSync(helper, 0o755);
    }
  }
}
