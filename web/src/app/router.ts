// A tiny hash router: no dependency, and routes are a closed list so unknown paths cannot reach
// any page. Invite tokens live in the fragment, which browsers never send to the server.

export type Route =
  | { name: 'home' }
  | { name: 'invite' }
  | { name: 'join'; link: string }
  | { name: 'chat'; id: string }
  | { name: 'not-found' };

const CHAT_ID = /^[0-9a-f]{1,128}$/;
const NOT_FOUND: Route = { name: 'not-found' };

/** Maps `location.hash` (for example "#/chat/ab12") to a route. Anything unlisted is not-found. */
export function parseRoute(hash: string): Route {
  const path = hash.startsWith('#') ? hash.slice(1) : hash;
  if (path === '' || path === '/') return { name: 'home' };
  if (path === '/invite') return { name: 'invite' };
  if (path.startsWith('/join/')) return { name: 'join', link: path };
  const chat = path.startsWith('/chat/') ? path.slice('/chat/'.length) : undefined;
  return chat !== undefined && CHAT_ID.test(chat) ? { name: 'chat', id: chat } : NOT_FOUND;
}

export const routeHref = {
  home: '#/',
  invite: '#/invite',
  chat: (id: string): string => `#/chat/${id}`,
} as const;
