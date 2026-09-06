import { spawn } from 'node:child_process';

const packageManager = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const rendererUrl = 'http://127.0.0.1:5173';

function run(command, args, options = {}) {
  return spawn(command, args, {
    cwd: import.meta.dirname + '/..',
    stdio: 'inherit',
    shell: process.platform === 'win32',
    ...options,
  });
}

function waitForServer(url) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30_000;
    const check = async () => {
      try {
        await fetch(url);
        resolve();
      } catch (error) {
        if (Date.now() >= deadline) {
          reject(error);
          return;
        }
        setTimeout(check, 100);
      }
    };
    void check();
  });
}

const build = run(packageManager, ['build']);
const buildExitCode = await new Promise((resolve) => {
  build.once('exit', (code) => resolve(code ?? 1));
});
if (buildExitCode !== 0) process.exit(buildExitCode);

const vite = run(packageManager, ['exec', 'vite', '--config', 'vite.config.ts', '--host', '127.0.0.1']);
let electron;
try {
  await waitForServer(rendererUrl);
  electron = run(packageManager, ['exec', 'electron', '.'], {
    env: { ...process.env, DESKTOP_RENDERER_URL: rendererUrl },
  });
  await new Promise((resolve) => electron.once('exit', resolve));
} finally {
  vite.kill();
}
