import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { registerSW } from 'virtual:pwa-register';
import { startConnectivity } from './lib/connectivity';

registerSW({ immediate: true });
startConnectivity();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
