import { createRoot } from 'react-dom/client';

import { App } from './app/App';
import { checkThisPage } from './app/trustedTypes';
import './app/theme.css';
import { registerServiceWorker } from './sw/register';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('Missing #root element');
}
if (import.meta.env.PROD && checkThisPage() === 'not_enforced') {
  // textContent is not a Trusted Types sink, so this is safe to use here.
  root.textContent =
    'Security settings are missing, so the app did not start. Reload, or contact support.';
} else {
  createRoot(root).render(<App />);
}
registerServiceWorker();
