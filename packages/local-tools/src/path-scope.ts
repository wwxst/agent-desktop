import { realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

/**
 * 一次路径解析的结果。
 * 越界不是「工具失败」而是「范围不允许」：两种情况都返回可见的具体原因，且都不做任何读取。
 */
export type ScopedPath =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly message: string };

function failure(code: unknown, fallback: string, target: string, label: string): ScopedPath {
  return { ok: false, message: `${label}（${typeof code === 'string' ? code : fallback}）：${target}` };
}

/**
 * 把请求路径解析到会话已确认的工作目录范围内。
 *
 * 范围判断必须落在**真实路径**上：`..`、符号链接和 Windows 目录联接先由 `realpath` 消掉，
 * 再用「相对根目录的路径是否跳出根」判断。字符串前缀在这里是错的——`D:\work-evil` 以 `D:\work`
 * 为前缀却完全在范围外，而一个指向根目录之外的联接又不会有任何可疑的前缀。
 *
 * `requested` 省略时解析到根目录本身；没有根目录时只接受绝对路径，但绝对路径同样要落在根目录内，
 * 否则一律给出「请先用 set_working_directory 指定包含它的目录」这一具体指引，而不是悄悄扩大范围。
 */
export async function resolveScopedPath(
  rootDirectory: string | undefined,
  requested: string | undefined,
): Promise<ScopedPath> {
  let root: string | undefined;
  if (rootDirectory !== undefined) {
    try {
      root = await realpath(rootDirectory);
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return failure(
        (error as NodeJS.ErrnoException).code,
        error.message,
        rootDirectory,
        '工作目录不可用',
      );
    }
  }

  if (requested === undefined) {
    return root === undefined
      ? { ok: false, message: '当前会话还没有工作目录，请先用 set_working_directory 指定一个目录。' }
      : { ok: true, path: root };
  }

  let candidate: string;
  if (isAbsolute(requested)) {
    candidate = requested;
  } else if (root === undefined) {
    // 相对路径没有基准时不能猜用户主目录或应用安装目录，直接给出明确指引。
    return {
      ok: false,
      message: `当前会话还没有工作目录，无法解析相对路径「${requested}」；请提供绝对路径或先用 set_working_directory 指定一个目录。`,
    };
  } else {
    candidate = resolve(root, requested);
  }

  let real: string;
  try {
    real = await realpath(candidate);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return failure((error as NodeJS.ErrnoException).code, error.message, candidate, '无法访问该路径');
  }

  if (root === undefined) {
    return {
      ok: false,
      message: `该路径不在当前会话的工作目录内：${real}。请先用 set_working_directory 指定包含它的目录。`,
    };
  }

  const relativePath = relative(root, real);
  if (relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))) {
    return { ok: true, path: real };
  }
  return {
    ok: false,
    message: `该路径不在当前会话的工作目录内：${real}。请先用 set_working_directory 指定包含它的目录。`,
  };
}

/**
 * 解析一个**将要创建**的路径。
 *
 * 目标本身还不存在，因此不能对它做 `realpath`：这里对**父目录**做真实路径范围判断，再拼上文件名。
 * 父目录不存在时直接失败——当前不创建中间目录（递归创建不在本阶段范围内）。
 * 复用同一条范围规则：父目录的真实路径必须落在根目录内，所以 `..` 与联接同样无法把目标挪出范围。
 */
export async function resolveCreatablePath(
  rootDirectory: string | undefined,
  requested: string,
): Promise<ScopedPath> {
  const parent = await resolveScopedPath(rootDirectory, dirname(requested));
  if (!parent.ok) return parent;
  return { ok: true, path: join(parent.path, basename(requested)) };
}
