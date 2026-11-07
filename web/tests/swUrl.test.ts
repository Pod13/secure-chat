import { describe, expect, test } from 'vitest';

import { SW_PATH, SW_POLICY, serviceWorkerUrl, type PolicyFactory } from '../src/sw/swUrl';

function factory() {
  const created: { name: string; rules: { createScriptURL(input: string): string } }[] = [];
  const policies: PolicyFactory = {
    createPolicy(name, rules) {
      created.push({ name, rules });
      return { createScriptURL: (input) => `trusted:${rules.createScriptURL(input)}` };
    },
  };
  return { policies, created };
}

describe('service worker URL', () => {
  test('is the plain path in browsers without Trusted Types', () => {
    expect(serviceWorkerUrl(undefined)).toBe(SW_PATH);
  });

  test('is made through one named policy that only allows the worker script', () => {
    const { policies, created } = factory();
    expect(serviceWorkerUrl(policies)).toBe('trusted:/sw.js');
    expect(created).toHaveLength(1);
    expect(created[0]?.name).toBe(SW_POLICY);
    const rules = created[0]?.rules as { createScriptURL(input: string): string };
    expect(rules.createScriptURL('/sw.js')).toBe('/sw.js');
    for (const other of [
      '/evil.js',
      'https://evil.example/sw.js',
      '/sw.js?x=1',
      '//evil/sw.js',
      '',
    ]) {
      expect(() => rules.createScriptURL(other), other).toThrow('worker');
    }
  });
});
