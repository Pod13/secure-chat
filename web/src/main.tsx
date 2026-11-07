import { createRoot } from 'react-dom/client';

import { App } from './app/App';
import './app/theme.css';

const root = document.getElementById('root');
if (root === null) {
  throw new Error('Missing #root element');
}
createRoot(root).render(<App />);
