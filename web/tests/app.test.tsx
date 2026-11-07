import { renderToString } from 'react-dom/server';
import { describe, expect, test } from 'vitest';

import { App, Page } from '../src/app/App';
import { ControllerContext } from '../src/app/context';
import type { AppController, Phase, Snapshot } from '../src/app/controller';
import { Alert } from '../src/app/components/Alert';
import { Button } from '../src/app/components/Button';
import { TextField } from '../src/app/components/TextField';
import { describeError } from '../src/app/errors';
import { parseRoute, routeHref } from '../src/app/router';

describe('routing', () => {
  test('known paths map to pages', () => {
    expect(parseRoute('')).toEqual({ name: 'home' });
    expect(parseRoute('#')).toEqual({ name: 'home' });
    expect(parseRoute('#/')).toEqual({ name: 'home' });
    expect(parseRoute('#/invite')).toEqual({ name: 'invite' });
    expect(parseRoute('#/join/abc~def')).toEqual({ name: 'join', link: '/join/abc~def' });
    expect(parseRoute('#/chat/ab12')).toEqual({ name: 'chat', id: 'ab12' });
    expect(routeHref.home).toBe('#/');
    expect(routeHref.invite).toBe('#/invite');
    expect(routeHref.chat('ab')).toBe('#/chat/ab');
  });

  test('everything else is not-found', () => {
    for (const hash of [
      '#/nope',
      '#/../etc',
      '#constructor',
      '#__proto__',
      '#/ ',
      '#/chat/',
      '#/chat/XYZ',
      '#/chat/ab/cd',
      '#/invite/x',
    ]) {
      expect(parseRoute(hash), hash).toEqual({ name: 'not-found' });
    }
  });
});

function snapshot(phase: Phase, extra: Partial<Snapshot> = {}): Snapshot {
  return {
    phase,
    recoveryKey: undefined,
    connection: 'open',
    conversations: [],
    revision: 0,
    ...extra,
  };
}

function stub(shot: Snapshot): AppController {
  return {
    getSnapshot: () => shot,
    subscribe: () => () => undefined,
    view: () => new Promise(() => undefined),
  } as unknown as AppController;
}

const render = (shot: Snapshot, hash = ''): string => {
  const original = globalThis.window;
  Object.defineProperty(globalThis, 'window', {
    value: { location: { hash } },
    configurable: true,
  });
  try {
    return renderToString(<App controller={stub(shot)} />);
  } finally {
    Object.defineProperty(globalThis, 'window', { value: original, configurable: true });
  }
};

describe('screens by phase', () => {
  test('loading', () => expect(render(snapshot('starting'))).toContain('Loading'));

  test('sign-up asks for an invite, a name that stays on the device, and a passcode twice', () => {
    const html = render(snapshot('sign-up'), '#/join/AAA~BBB');
    expect(html).toContain('Create your account');
    expect(html).toContain('value="/join/AAA~BBB"');
    expect(html).toContain('The server never sees it');
    expect(html.match(/type="password"/g)).toHaveLength(2);
    expect(html.match(/<main/g)?.length).toBe(1);
  });

  test('the Recovery Key is shown with a warning and Continue waits for confirmation', () => {
    const html = render(snapshot('recovery-key', { recoveryKey: 'AAAAA-BBBBB' }));
    expect(html).toContain('AAAAA-BBBBB');
    expect(html).toContain('only way to get your account back');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Continue/);
  });

  test('unlock asks for the passcode', () => {
    expect(render(snapshot('locked'))).toContain('current-password');
  });

  test('a removed device is told so', () => {
    expect(render(snapshot('unlinked'))).toContain('removed from the account');
  });

  test('the conversation list shows connection state and invites', () => {
    const html = render(
      snapshot('ready', {
        conversations: [
          { id: 'ab', lastText: 'hello' },
          { id: 'cd', lastText: undefined },
        ],
      }),
    );
    expect(html).toContain('Connected');
    expect(html).toContain('href="#/chat/ab"');
    expect(html).toContain('hello');
    expect(html).toContain('New conversation');
    expect(html).toContain('href="#/invite"');
  });

  test('with no conversations it suggests inviting someone', () => {
    expect(render(snapshot('ready'))).toContain('No conversations yet');
  });
});

describe('pages', () => {
  const page = (route: Parameters<typeof Page>[0]['route']) =>
    renderToString(
      <ControllerContext.Provider value={stub(snapshot('ready'))}>
        <Page route={route} />
      </ControllerContext.Provider>,
    );

  test('invite, join and conversation pages render with a way back', () => {
    expect(page({ name: 'invite' })).toContain('Make an invite link');
    expect(page({ name: 'join', link: '/join/' })).toContain('Start conversation');
    const chat = page({ name: 'chat', id: 'ab' });
    expect(chat).toContain('aria-live="polite"');
    expect(chat).toContain('href="#/"');
  });

  test('an unknown page tells the user at once and offers a way back', () => {
    const html = page({ name: 'not-found' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('href="#/"');
  });
});

describe('components', () => {
  test('a text field ties label, hint and error to the input', () => {
    const html = renderToString(<TextField label="Name" hint="Only here" error="Required" />);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toMatch(/aria-describedby="[^"]+-hint [^"]+-error"/);
  });

  test('buttons default to type button; alerts can be urgent', () => {
    expect(renderToString(<Button>Go</Button>)).toContain('type="button"');
    expect(renderToString(<Alert urgent>Oops</Alert>)).toContain('role="alert"');
  });
});

describe('error messages', () => {
  test('known codes say what to do, unknown ones stay generic and reveal nothing', () => {
    expect(describeError({ code: 'invite_invalid' })).toContain('not valid');
    expect(describeError({ code: 'wrong_passcode' })).toContain('not right');
    for (const odd of [
      new Error('secret detail'),
      null,
      undefined,
      'x',
      { code: 5 },
      { code: 'nope' },
    ]) {
      expect(describeError(odd)).toBe('Something went wrong. Try again.');
    }
  });
});

describe('QR code', () => {
  test('is drawn from shapes, never from an HTML string, and carries a label', async () => {
    const { QrCode } = await import('../src/app/components/QrCode');
    const html = renderToString(
      <QrCode text="https://chat.example/#/join/abc" label="Invite QR" />,
    );
    expect(html).toContain('<svg');
    expect(html).toContain('aria-label="Invite QR"');
    expect(html.match(/<rect/g)?.length).toBeGreaterThan(100);
    expect(html).not.toContain('<script');
  });

  test('different text gives a different picture', async () => {
    const { QrCode } = await import('../src/app/components/QrCode');
    const a = renderToString(<QrCode text="one" label="x" />);
    const b = renderToString(<QrCode text="two" label="x" />);
    expect(a).not.toBe(b);
  });
});
