// THROWAWAY fixture-only entry. Never mounts App, auth, cart or API providers.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import '../../index.css';
import WalletCreditPrototype from './index';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter basename={import.meta.env.BASE_URL}>
      <WalletCreditPrototype standalone />
    </BrowserRouter>
  </StrictMode>,
);
