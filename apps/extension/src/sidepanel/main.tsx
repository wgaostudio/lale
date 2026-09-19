import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@lale/ui';
import 'katex/dist/katex.min.css';
import { App } from './App';
import './sidepanel.css';

const container = document.querySelector<HTMLElement>('#app');
if (!container) throw new Error('Missing #app root');

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
