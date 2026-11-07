import { renderToString } from 'react-dom/server';
import { expect, test } from 'vitest';

import { App } from '../src/app/App';

test('App renders its title', () => {
  expect(renderToString(<App />)).toContain('Secure Chat');
});
