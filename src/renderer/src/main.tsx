/**
 * Renderer entry point.
 *
 * No browser storage is used anywhere in the renderer: state that must persist
 * goes through the database worker, which is the only owner of durable data.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App.tsx';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('the renderer root element is missing');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
