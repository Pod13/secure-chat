import { createRoot } from 'react-dom/client';

import { App } from './app/App';
import { AppController } from './app/controller';
import { checkThisPage } from './app/trustedTypes';
import './app/theme.css';
import { loadMls } from './crypto/wasm';
import { createSodium } from './crypto/sodium';
import { createHttpNetwork } from './net/http';
import type { SocketLike } from './net/socket';
import { systemClock, webRandom } from './ports';
import { registerServiceWorker } from './sw/register';
import { openIndexedDbStore } from './store/indexeddb';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('Missing #root element');
}

async function start(target: HTMLElement): Promise<void> {
  const [sodium, bridge, store] = await Promise.all([
    createSodium(webRandom),
    loadMls(),
    openIndexedDbStore(indexedDB),
  ]);
  const controller = new AppController({
    store,
    sodium,
    random: webRandom,
    clock: systemClock,
    bridge,
    network: createHttpNetwork(),
    sockets: {
      open: (url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike,
      after: (ms, fn) => {
        const timer = setTimeout(fn, ms);
        return () => clearTimeout(timer);
      },
      random: webRandom,
    },
    origin: window.location.origin,
    wsUrl: `${window.location.origin.replace(/^http/, 'ws')}/v1/ws`,
  });
  createRoot(target).render(<App controller={controller} />);
  window.addEventListener('online', () => controller.networkRestored());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') controller.networkRestored();
  });
  await controller.start();
}

if (import.meta.env.PROD && checkThisPage() === 'not_enforced') {
  // textContent is not a Trusted Types sink, so this is safe to use here.
  root.textContent =
    'Security settings are missing, so the app did not start. Reload, or contact support.';
} else {
  start(root).catch(() => {
    root.textContent = 'The app could not start. Reload the page, or try another browser.';
  });
}
registerServiceWorker();
