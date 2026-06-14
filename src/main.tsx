import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import './index.css';
import App from './App.tsx';
import { KeyProvider } from './crypto/KeyContext';
import { MetadataKeyProvider } from './crypto/MetadataKeyContext';
import { ToastProvider } from './components/Toast';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <KeyProvider>
      <MetadataKeyProvider>
        <ToastProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </ToastProvider>
      </MetadataKeyProvider>
    </KeyProvider>
  </StrictMode>,
);
