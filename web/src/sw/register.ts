// Starts the service worker in production builds, where it guards every file that is served.
// (Not used by `vite dev`, which serves unbundled modules that no manifest could list.)

export function registerServiceWorker(): void {
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    void navigator.serviceWorker.register('/sw.js');
  }
}
