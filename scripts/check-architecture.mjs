import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import process from 'node:process';
import { createScanner, SyntaxKind } from 'typescript/unstable/ast';

const rootDirectory = process.cwd();
const workspaceDirectories = ['packages', 'examples', 'apps'];
const corePackages = new Set([
  '@agent-desktop/model',
  '@agent-desktop/session',
  '@agent-desktop/system-prompt',
  '@agent-desktop/tools',
  '@agent-desktop/agent',
  '@agent-desktop/agent-loop',
]);
const providerPackages = new Set(['@agent-desktop/model-deepseek']);
const toolPackages = new Set([
  '@agent-desktop/video-ffmpeg',
  '@agent-desktop/vision-openai',
  '@agent-desktop/speech-whisper-cpp',
]);
const forbiddenCoreModules = new Set(['react', 'react-dom', 'electron']);

async function findFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await findFiles(entryPath));
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
      files.push(entryPath);
    }
  }

  return files;
}

async function readWorkspacePackages() {
  const packages = [];

  for (const directoryName of workspaceDirectories) {
    const directory = join(rootDirectory, directoryName);
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const directoryPath = join(directory, entry.name);
      const packageJsonPath = join(directoryPath, 'package.json');
      // 只有存在 package.json 的目录才是当前 workspace package；未来方向的空目录不进入依赖图。
      const childEntries = await readdir(directoryPath, { withFileTypes: true });
      if (!childEntries.some((childEntry) => childEntry.isFile() && childEntry.name === 'package.json')) continue;
      const packageJson = JSON.parse(await readFile(packageJsonPath, 'utf8'));
      packages.push({ directoryPath, packageJson });
    }
  }

  return packages;
}

function declaredDependencies(packageJson) {
  const sections = [
    packageJson.dependencies,
    packageJson.devDependencies,
    packageJson.optionalDependencies,
    packageJson.peerDependencies,
  ];
  const dependencies = new Set();

  for (const section of sections) {
    for (const name of Object.keys(section ?? {})) dependencies.add(name);
  }

  return dependencies;
}

function workspacePackageName(specifier, workspaceNames) {
  for (const name of workspaceNames) {
    if (specifier === name || specifier.startsWith(`${name}/`)) return name;
  }

  return undefined;
}

function isNamedModule(specifier, names) {
  return [...names].some((name) => specifier === name || specifier.startsWith(`${name}/`));
}

function collectModuleSpecifiers(source) {
  const specifiers = new Set();
  // TypeScript 7 将稳定编译器 API 保留给 tsc；这里使用同版本的词法扫描器，跳过注释并读取真实字符串字面量。
  const scanner = createScanner(true, 0, source);
  let previousToken = SyntaxKind.Unknown;
  let moduleStatement = false;
  let dynamicImport = false;
  let token = scanner.scan();
  while (token !== SyntaxKind.EndOfFile) {
    if (token === SyntaxKind.ImportKeyword || token === SyntaxKind.ExportKeyword) {
      moduleStatement = true;
    } else if (token === SyntaxKind.OpenParenToken
      && previousToken === SyntaxKind.ImportKeyword) {
      dynamicImport = true;
    } else if (token === SyntaxKind.StringLiteral
      && moduleStatement
      && (previousToken === SyntaxKind.ImportKeyword
        || previousToken === SyntaxKind.FromKeyword
        || dynamicImport)) {
      specifiers.add(scanner.getTokenValue());
      moduleStatement = false;
      dynamicImport = false;
    } else if (token === SyntaxKind.SemicolonToken) {
      moduleStatement = false;
      dynamicImport = false;
    } else if (dynamicImport && token !== SyntaxKind.StringLiteral) {
      moduleStatement = false;
      dynamicImport = false;
    }

    previousToken = token;
    token = scanner.scan();
  }

  return specifiers;
}

async function sourceImports(directoryPath) {
  const specifiers = new Set();

  for (const sourceDirectoryName of ['src', 'tests']) {
    const sourceDirectory = join(directoryPath, sourceDirectoryName);
    let files;
    try {
      files = await findFiles(sourceDirectory);
    } catch (error) {
      // tests 目录按需存在；缺失目录不是架构错误，其他文件系统错误继续暴露。
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue;
      throw error;
    }

    for (const filePath of files) {
      const source = await readFile(filePath, 'utf8');
      for (const specifier of collectModuleSpecifiers(source)) specifiers.add(specifier);
    }
  }

  return specifiers;
}

function addFinding(findings, packageName, message) {
  findings.push(`${packageName}: ${message}`);
}

async function main() {
  const packages = await readWorkspacePackages();
  const workspaceNames = new Set(packages.map(({ packageJson }) => packageJson.name));
  const findings = [];

  for (const { directoryPath, packageJson } of packages) {
    const packageName = packageJson.name;
    const imports = await sourceImports(directoryPath);
    const importedWorkspacePackages = new Set();
    const declared = declaredDependencies(packageJson);

    for (const specifier of imports) {
      const workspaceName = workspacePackageName(specifier, workspaceNames);
      if (workspaceName) importedWorkspacePackages.add(workspaceName);

      if (corePackages.has(packageName)
        && (isNamedModule(specifier, forbiddenCoreModules)
          || [...providerPackages, ...toolPackages].includes(workspaceName))) {
        addFinding(findings, packageName, `core source imports forbidden module ${specifier}`);
      }

      if (!packageName.startsWith('@agent-desktop/example-')
        && workspaceName?.startsWith('@agent-desktop/example-')) {
        addFinding(findings, packageName, `package source imports example package ${workspaceName}`);
      }
    }

    for (const dependency of declared) {
      if (packageName.startsWith('@agent-desktop/')
        && !packageName.startsWith('@agent-desktop/example-')
        && dependency.startsWith('@agent-desktop/example-')) {
        addFinding(findings, packageName, `declares example package dependency ${dependency}`);
      }

      if (corePackages.has(packageName)
        && (isNamedModule(dependency, forbiddenCoreModules)
          || providerPackages.has(dependency)
          || toolPackages.has(dependency))) {
        addFinding(findings, packageName, `core package declares forbidden dependency ${dependency}`);
      }
    }

    for (const importedWorkspacePackage of importedWorkspacePackages) {
      // package 可以通过自身 workspace 名称引用导出，不需要把自己声明为依赖。
      if (importedWorkspacePackage !== packageName && !declared.has(importedWorkspacePackage)) {
        addFinding(findings, packageName, `imports undeclared workspace dependency ${importedWorkspacePackage}`);
      }
    }
  }

  if (findings.length > 0) {
    process.stderr.write('Architecture check failed:\n');
    for (const finding of findings) process.stderr.write(`- ${finding}\n`);
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`Architecture check passed for ${packages.length} workspace packages.\n`);
}

await main();
