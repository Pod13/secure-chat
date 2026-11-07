// With `require-trusted-types-for 'script'`, the browser refuses a plain string where it expects
// a script URL, and registering a service worker is such a place. The page allows exactly one
// policy, named below, and it can produce exactly one URL: the worker's own script.

export const SW_PATH = '/sw.js';
export const SW_POLICY = 'sw-url';

export interface PolicyFactory {
  createPolicy(
    name: string,
    rules: { createScriptURL(input: string): string },
  ): { createScriptURL(input: string): string };
}

/** The value to pass to `serviceWorker.register`: a trusted URL where the browser needs one. */
export function serviceWorkerUrl(factory: PolicyFactory | undefined): string {
  if (factory === undefined) return SW_PATH;
  const policy = factory.createPolicy(SW_POLICY, {
    createScriptURL(input) {
      if (input !== SW_PATH) throw new TypeError('Only the service worker script is allowed');
      return input;
    },
  });
  return policy.createScriptURL(SW_PATH);
}
