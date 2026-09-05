import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import viteConfig from '../vite.config.js';

describe('desktop renderer build', () => {
  it('uses file-compatible asset URLs and a local content security policy', async () => {
    expect(viteConfig).toMatchObject({ base: './' });

    const html = await readFile(
      new URL('../src/renderer/index.html', import.meta.url),
      'utf8',
    );
    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain("default-src 'self'");
  });
});
