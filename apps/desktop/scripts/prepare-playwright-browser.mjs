import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { chromium } from 'playwright';

const executable = chromium.executablePath();
const sourceRoot = resolve(dirname(executable), '..');
const targetRoot = resolve('resources/playwright/chromium');

await mkdir(dirname(targetRoot), { recursive: true });
await rm(targetRoot, { recursive: true, force: true });
await cp(sourceRoot, targetRoot, { recursive: true, force: true });
console.log(`Playwright Chromium 已复制到 ${targetRoot}`);
