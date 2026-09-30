import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

const tg = (window as any).Telegram?.WebApp;
tg?.ready?.();
tg?.expand?.();
window.addEventListener('load', () => {
  const t = (window as any).Telegram?.WebApp;
  t?.ready?.();
  t?.expand?.();
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
