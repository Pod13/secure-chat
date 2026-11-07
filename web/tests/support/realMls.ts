// The compiled OpenMLS module for Node, so tests can run real cryptography instead of a fake.
// Build it with `scripts/build-wasm.sh`.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { createBridge, type MlsBridge, type MlsModule } from '../../src/crypto/bridge';

const MODULE_PATH = fileURLToPath(new URL('../../../.wasm-node/crypto_wasm.js', import.meta.url));

export function realBridge(): MlsBridge {
  if (!existsSync(MODULE_PATH)) {
    throw new Error('The MLS module is not built. Run scripts/build-wasm.sh first.');
  }
  return createBridge(createRequire(import.meta.url)(MODULE_PATH) as MlsModule);
}
