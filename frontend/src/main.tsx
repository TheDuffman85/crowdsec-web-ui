import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import "flag-icons/css/flag-icons.min.css";
import './index.css';
import App from './App';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Root element not found');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
