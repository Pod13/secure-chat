import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

const dir = join(__dirname, '..', '..', '.github', 'workflows');
const workflows = readdirSync(dir)
  .filter((f) => f.endsWith('.yml'))
  .map((f) => ({ name: f, text: readFileSync(join(dir, f), 'utf8') }));

describe('workflow files', () => {
  test('there are workflows to check', () => {
    expect(workflows.map((w) => w.name)).toContain('ci.yml');
    expect(workflows.map((w) => w.name)).toContain('release.yml');
  });

  test('every action is pinned to a full commit SHA with its version in a comment', () => {
    for (const { name, text } of workflows) {
      const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)];
      expect(uses.length, name).toBeGreaterThan(0);
      for (const [, action, rest] of uses) {
        expect(action, `${name}: ${action}`).toMatch(/@[0-9a-f]{40}$/);
        expect(rest, `${name}: ${action}`).toMatch(/#\s*v\d/);
      }
    }
  });

  test('each workflow starts with read-only permissions', () => {
    for (const { name, text } of workflows) {
      expect(text, name).toMatch(/^permissions:\n {2}contents: read\n/m);
    }
  });

  test('no workflow can write with a broad token or run untrusted pull request code with secrets', () => {
    for (const { name, text } of workflows) {
      expect(text, name).not.toMatch(/pull_request_target/);
      expect(text, name).not.toMatch(/permissions:\s*write-all/);
    }
  });
});

describe('release workflow', () => {
  const release = workflows.find((w) => w.name === 'release.yml')?.text ?? '';

  test('never has access to a signing key', () => {
    expect(release).not.toMatch(/secrets\.[A-Z_]*(KEY|SIGN|HSM)/i);
    expect(release).not.toMatch(/PRIVATE|BEGIN [A-Z ]*KEY/);
    expect(release).not.toMatch(/sign-manifest\.ts\s+sign\b/);
  });

  test('the signature step needs manual approval and checks the signature before publishing', () => {
    expect(release).toContain('environment: release-signing');
    expect(release).toMatch(/sign-manifest\.ts attach/);
  });

  test('provenance is attested for both the build and the signed manifest', () => {
    expect(release.match(/actions\/attest-build-provenance@/g)?.length).toBe(2);
    expect(release).toMatch(/attestations: write/);
  });

  test('releases are built only from version tags', () => {
    expect(release).toContain("tags: ['v[0-9]+.[0-9]+.[0-9]+']");
  });
});
