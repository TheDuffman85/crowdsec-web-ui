import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { I18nProvider } from './lib/I18nProvider';
import { DateTimeProvider } from './lib/DateTimeProvider';
import { FontProvider } from './lib/FontProvider';
import { assetUrl } from './lib/basePath';

const root = document.getElementById('root');

// The service worker gives the installed app an offline page and receives Web Push. It stores no data.
if (import.meta.env.PROD && 'serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register(assetUrl('/sw.js')).catch(() => { /* The app works without it. */ });
  });
}

if (!root) {
  throw new Error('Root element not found');
}

createRoot(root).render(
  <StrictMode>
    <I18nProvider>
      <FontProvider>
        <DateTimeProvider>
          <App />
        </DateTimeProvider>
      </FontProvider>
    </I18nProvider>
  </StrictMode>,
);
