// Loads the compiled OpenMLS module in the browser. It is built from `crypto-wasm/` by
// `scripts/build-wasm.sh web`, shipped as a hashed asset, and listed in the signed manifest like
// every other file. Covered by the end-to-end tests, since it needs a real browser.

import { createBridge, type MlsBridge, type MlsModule } from './bridge';

export async function loadMls(): Promise<MlsBridge> {
  const module = await import('../wasm/crypto_wasm.js');
  await module.default();
  return createBridge(module as unknown as MlsModule);
}
