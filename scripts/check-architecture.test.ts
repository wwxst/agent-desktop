import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

interface CheckResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function runArchitectureCheck(cwd: string): Promise<CheckResult> {
  const scriptPath = resolve(process.cwd(), 'scripts/check-architecture.mjs');

  return new Promise((resolveResult, reject) => {
    execFile(process.execPath, [scriptPath], { cwd }, (error, stdout, stderr) => {
      if (!error) {
        resolveResult({ code: 0, stdout, stderr });
        return;
      }

      if (typeof error.code !== 'number') {
        reject(error);
        return;
      }

      resolveResult({ code: error.code, stdout, stderr });
    });
  });
}

async function createFixture(testSource: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-desktop-architecture-test-'));
  await mkdir(join(root, 'apps'), { recursive: true });
  await mkdir(join(root, 'examples'), { recursive: true });
  await mkdir(join(root, 'packages', 'model', 'src'), { recursive: true });
  await mkdir(join(root, 'packages', 'sample', 'src'), { recursive: true });
  await mkdir(join(root, 'packages', 'sample', 'tests'), { recursive: true });

  await writeFile(join(root, 'packages', 'model', 'package.json'), JSON.stringify({
    name: '@agent-desktop/model',
    private: true,
    type: 'module',
  }));
  await writeFile(join(root, 'packages', 'model', 'src', 'index.ts'), 'export type Model = unknown;');
  await writeFile(join(root, 'packages', 'sample', 'package.json'), JSON.stringify({
    name: '@agent-desktop/sample',
    private: true,
    type: 'module',
  }));
  await writeFile(join(root, 'packages', 'sample', 'src', 'index.ts'), 'export {};');
  await writeFile(join(root, 'packages', 'sample', 'tests', 'sample.test.ts'), testSource);

  return root;
}

describe('architecture gate', () => {
  it('rejects undeclared workspace imports from tests', async () => {
    const root = await createFixture("import type { Model } from '@agent-desktop/model';\nvoid (null as Model);\n");

    try {
      const result = await runArchitectureCheck(root);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        '@agent-desktop/sample: imports undeclared workspace dependency @agent-desktop/model',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('checks workspace imports declared by desktop apps from TSX source', async () => {
    const root = await createFixture('export {};\n');
    await mkdir(join(root, 'apps', 'desktop', 'src'), { recursive: true });
    await writeFile(join(root, 'apps', 'desktop', 'package.json'), JSON.stringify({
      name: '@agent-desktop/desktop',
      private: true,
      type: 'module',
    }));
    await writeFile(
      join(root, 'apps', 'desktop', 'src', 'index.tsx'),
      "import type { Model } from '@agent-desktop/model';\nvoid (null as Model);\n",
    );

    try {
      const result = await runArchitectureCheck(root);

      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        '@agent-desktop/desktop: imports undeclared workspace dependency @agent-desktop/model',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('allows a package to import its own workspace name from tests', async () => {
    const root = await createFixture("import type { Model } from '@agent-desktop/sample';\nvoid (null as Model);\n");

    try {
      const result = await runArchitectureCheck(root);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Architecture check passed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
