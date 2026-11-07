// Starts the service worker in production builds, where it guards every file that is served.
// (Not used by `vite dev`, which serves unbundled modules that no manifest could list.)

import { serviceWorkerUrl, type PolicyFactory } from './swUrl';

export function registerServiceWorker(): void {
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    const factory = (window as { trustedTypes?: PolicyFactory }).trustedTypes;
    void navigator.serviceWorker.register(serviceWorkerUrl(factory));
  }
}
