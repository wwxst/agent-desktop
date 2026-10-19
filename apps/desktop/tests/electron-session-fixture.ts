/** 仅替换 Electron 会话的 HTTP 边界，保留每个请求及重定向的 onBeforeRequest 语义。 */
export function fetchSessionFixture(fetcher: (url: string, init?: RequestInit) => Promise<Response>) {
  let listener: ((details: { url: string; method: string }, callback: (result: { cancel: boolean }) => void) => void) | null = null;
  return {
    webRequest: { onBeforeRequest: (next: typeof listener) => { listener = next; } },
    fetch: async (url: string, init?: RequestInit): Promise<Response> => {
      let target = url;
      for (let redirects = 0; redirects <= 20; redirects += 1) {
        const decision = await new Promise<{ cancel: boolean }>(resolve => listener!({ url: target, method: 'GET' }, resolve));
        if (decision.cancel) throw new Error('net::ERR_BLOCKED_BY_CLIENT');
        const response = await fetcher(target, init);
        if (![301, 302, 303, 307, 308].includes(response.status)) return response;
        const location = response.headers.get('location');
        if (location === null) return response;
        await response.body?.cancel(); target = new URL(location, target).href;
      }
      throw new Error('net::ERR_TOO_MANY_REDIRECTS');
    },
  };
}
