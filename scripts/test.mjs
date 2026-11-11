// Runs Vitest from a cwd with an uppercase drive letter. shortcut: works around Vitest loading its runner twice
// on Windows when the terminal reports "c:\" (e.g. VS Code); remove once fixed upstream.
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
const cwd = process.cwd().replace(/^[a-z]:/, (d) => d.toUpperCase());
const r = spawnSync(process.execPath, [join(cwd, 'node_modules', 'vitest', 'vitest.mjs'), 'run', ...process.argv.slice(2)], { cwd, stdio: 'inherit' });
process.exit(r.status ?? 1);
