import { describe, expect, test } from 'vitest';

import {
  BridgeError,
  EXPECTED_CIPHERSUITE,
  createBridge,
  type MlsModule,
  type WasmClientLike,
} from '../src/crypto/bridge';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);

interface Spy {
  freed: string[];
  failWith?: unknown;
}

/** A stand-in for the compiled WASM module that records how it is used. */
function fakeModule(spy: Spy, suite = EXPECTED_CIPHERSUITE): MlsModule {
  const guard = <T>(value: T): T => {
    if (spy.failWith !== undefined) throw spy.failWith;
    return value;
  };
  class Fake implements WasmClientLike {
    constructor(readonly identity: Uint8Array) {}
    key_package = () => guard(bytes(1));
    last_resort_key_package = () => guard(bytes(8));
    export_state = () => guard(bytes(9, ...this.identity));
    static restore = (state: Uint8Array) => guard(new Fake(state.slice(1)));
    create_group = () => guard(bytes(2));
    add_member = (_g: Uint8Array, kp: Uint8Array) =>
      guard({
        commit: () => bytes(3, ...kp),
        welcome: () => bytes(4),
        free: () => spy.freed.push('added'),
      });
    join = () => guard(bytes(2));
    remove_member = (_g: Uint8Array, index: number) => guard(bytes(5, index));
    encrypt = (_g: Uint8Array, text: Uint8Array) => guard(bytes(6, ...text));
    receive = (_g: Uint8Array, data: Uint8Array) =>
      guard({
        kind: () => data[0] ?? 0,
        message: () => bytes(7),
        free: () => spy.freed.push('received'),
      });
    member_count = () => guard(2);
    member_index = (_g: Uint8Array, position: number) => guard(position * 10);
    member_identity = (_g: Uint8Array, index: number) => guard(bytes(index + 1));
    free = () => spy.freed.push('client');
  }
  return { ciphersuite_id: () => suite, WasmClient: Fake };
}

describe('createBridge', () => {
  test('accepts a module with the expected ciphersuite', () => {
    expect(EXPECTED_CIPHERSUITE).toBe(3);
    expect(() => createBridge(fakeModule({ freed: [] }))).not.toThrow();
  });

  test('refuses a module with any other ciphersuite', () => {
    for (const suite of [0, 1, 2, 4, 65535]) {
      expect(() => createBridge(fakeModule({ freed: [] }, suite))).toThrow(BridgeError);
    }
    try {
      createBridge(fakeModule({ freed: [] }, 1));
    } catch (error) {
      expect((error as BridgeError).code).toBe('incompatible_module');
    }
  });
});

describe('Device state', () => {
  const device = () => createBridge(fakeModule({ freed: [] })).newDevice(bytes(9));

  test('saves and restores a device, and offers a last-resort key package', () => {
    const d = device();
    expect([...d.lastResortKeyPackage()]).toEqual([8]);
    expect([...d.exportState()]).toEqual([9, 9]);
    const bridge = createBridge(fakeModule({ freed: [] }));
    expect([...bridge.restoreDevice(d.exportState()).exportState()]).toEqual([9, 9]);
  });

  test('turns a restore failure into a bridge error with a code', () => {
    const spy: Spy = { freed: [], failWith: 'malformed' };
    const bridge = createBridge(fakeModule(spy));
    try {
      bridge.restoreDevice(bytes(1));
      expect.unreachable();
    } catch (error) {
      expect((error as BridgeError).code).toBe('malformed');
    }
  });
});

describe('Device calls', () => {
  const device = () => createBridge(fakeModule({ freed: [] })).newDevice(bytes(9));

  test('passes bytes through for the plain operations', () => {
    const d = device();
    expect([...d.keyPackage()]).toEqual([1]);
    expect([...d.createGroup()]).toEqual([2]);
    expect([...d.join(bytes(0))]).toEqual([2]);
    expect([...d.removeMember(bytes(0), 4)]).toEqual([5, 4]);
    expect([...d.encrypt(bytes(0), bytes(8, 9))]).toEqual([6, 8, 9]);
  });

  test('add returns both messages and releases the wasm object', () => {
    const spy: Spy = { freed: [] };
    const d = createBridge(fakeModule(spy)).newDevice(bytes(9));
    const added = d.addMember(bytes(0), bytes(1, 2));
    expect([...added.commit]).toEqual([3, 1, 2]);
    expect([...added.welcome]).toEqual([4]);
    expect(spy.freed).toEqual(['added']);
  });

  test('receive maps each kind and releases the wasm object', () => {
    const spy: Spy = { freed: [] };
    const d = createBridge(fakeModule(spy)).newDevice(bytes(9));
    expect(d.receive(bytes(0), bytes(0))).toEqual({ kind: 'message', text: bytes(7) });
    expect(d.receive(bytes(0), bytes(1))).toEqual({ kind: 'group-changed' });
    expect(d.receive(bytes(0), bytes(2))).toEqual({ kind: 'removed' });
    expect(spy.freed).toEqual(['received', 'received', 'received']);
  });

  test('an unknown kind from the module is an internal error, not a guess', () => {
    const d = device();
    expect(() => d.receive(bytes(0), bytes(3))).toThrow(BridgeError);
  });

  test('members are listed with their index and identity', () => {
    expect(device().members(bytes(0))).toEqual([
      { index: 0, identity: bytes(1) },
      { index: 10, identity: bytes(11) },
    ]);
  });

  test('close releases the wasm client', () => {
    const spy: Spy = { freed: [] };
    createBridge(fakeModule(spy)).newDevice(bytes(9)).close();
    expect(spy.freed).toEqual(['client']);
  });
});

test('bridge errors are named', () => {
  expect(new BridgeError('internal').name).toBe('BridgeError');
  expect(new BridgeError('internal').message).toBe('internal');
});

describe('errors', () => {
  const failing = (failWith: unknown) => {
    const spy: Spy = { freed: [] };
    const d = createBridge(fakeModule(spy)).newDevice(bytes(9));
    spy.failWith = failWith;
    return d;
  };
  const codeOf = (action: () => unknown): string | undefined => {
    try {
      action();
    } catch (error) {
      return error instanceof BridgeError ? error.code : 'not-a-bridge-error';
    }
    return undefined;
  };

  test('known codes from the module are kept', () => {
    for (const code of [
      'malformed',
      'unsupported_ciphersuite',
      'unknown_group',
      'rejected',
      'too_large',
    ]) {
      expect(codeOf(() => failing(code).keyPackage())).toBe(code);
    }
  });
});

describe('errors, unknown', () => {
  const failing = (failWith: unknown) => {
    const spy: Spy = { freed: [] };
    const d = createBridge(fakeModule(spy)).newDevice(bytes(9));
    spy.failWith = failWith;
    return d;
  };
  const codeOf = (action: () => unknown): string | undefined => {
    try {
      action();
    } catch (error) {
      return error instanceof BridgeError ? error.code : 'not-a-bridge-error';
    }
    return undefined;
  };

  test('anything else becomes "internal" and never carries the original text', () => {
    for (const odd of ['secret text 123', new Error('boom with details'), 42, undefined]) {
      if (odd === undefined) continue;
      const d = failing(odd);
      expect(codeOf(() => d.encrypt(bytes(0), bytes(1)))).toBe('internal');
      try {
        d.encrypt(bytes(0), bytes(1));
      } catch (error) {
        expect((error as Error).message).toBe('internal');
      }
    }
  });

  test('every operation reports errors the same way', () => {
    const d = failing('rejected');
    const operations = [
      () => d.createGroup(),
      () => d.join(bytes(0)),
      () => d.addMember(bytes(0), bytes(0)),
      () => d.removeMember(bytes(0), 0),
      () => d.encrypt(bytes(0), bytes(0)),
      () => d.receive(bytes(0), bytes(0)),
      () => d.members(bytes(0)),
    ];
    for (const operation of operations) expect(codeOf(operation)).toBe('rejected');
  });
});
