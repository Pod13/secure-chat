import { renderToString } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import { App, Page } from '../src/app/App';
import { Alert } from '../src/app/components/Alert';
import { Button } from '../src/app/components/Button';
import { TextField } from '../src/app/components/TextField';
import { parseRoute, routeHref } from '../src/app/router';

describe('routing', () => {
  test('known paths map to pages, everything else is not-found', () => {
    expect(parseRoute('')).toBe('home');
    expect(parseRoute('#')).toBe('home');
    expect(parseRoute('#/')).toBe('home');
    expect(parseRoute('/')).toBe('home');
    for (const hash of ['#/nope', '#/../etc', '#constructor', '#__proto__', '#/ ']) {
      expect(parseRoute(hash), hash).toBe('not-found');
    }
    expect(routeHref.home).toBe('#/');
  });
});

describe('pages', () => {
  test('the home page has a title, a skip link and one main landmark', () => {
    const html = renderToString(<Page route="home" />);
    expect(html).toContain('<h1>Secure Chat</h1>');
    expect(html).toContain('href="#main"');
    expect(html.match(/<main/g)?.length).toBe(1);
  });

  test('an unknown page tells the user at once and offers a way back', () => {
    const html = renderToString(<Page route="not-found" />);
    expect(html).toContain('role="alert"');
    expect(html).toContain('href="#/"');
  });

  test('App starts from the address bar (no window on the server: falls back to home)', () => {
    const original = globalThis.window;
    Object.defineProperty(globalThis, 'window', {
      value: { location: { hash: '' } },
      configurable: true,
    });
    try {
      expect(renderToString(<App />)).toContain('Secure Chat');
    } finally {
      Object.defineProperty(globalThis, 'window', { value: original, configurable: true });
    }
  });
});

describe('components', () => {
  test('a button defaults to type=button so it never submits a form by accident', () => {
    expect(renderToString(<Button>Go</Button>)).toContain('type="button"');
    expect(renderToString(<Button type="submit">Go</Button>)).toContain('type="submit"');
  });

  test('a text field ties its label, hint and error to the input', () => {
    const html = renderToString(
      <TextField label="Username" hint="Letters only" error="Too short" />,
    );
    const id = /for="([^"]+)"/.exec(html)?.[1] ?? '';
    expect(id).not.toBe('');
    expect(html).toContain(`id="${id}"`);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain(`aria-describedby="${id}-hint ${id}-error"`);
  });

  test('a plain text field has no empty description or invalid flag', () => {
    const html = renderToString(<TextField label="Username" />);
    expect(html).not.toContain('aria-describedby');
    expect(html).not.toContain('aria-invalid');
  });

  test('alerts are announced assertively only when urgent', () => {
    expect(renderToString(<Alert>Saved</Alert>)).toContain('role="status"');
    expect(renderToString(<Alert urgent>Failed</Alert>)).toContain('role="alert"');
  });
});
