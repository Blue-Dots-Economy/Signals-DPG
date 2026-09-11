import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '@/lib/query-client';
import { purgeLegacyAuthStorage } from '@/lib/purge-legacy-auth-storage';
import { sweepLegacyMatchScoreCache } from '@/utils/match-score-cache';
import { App } from './app';
import '@/components/wallet/providers';
import './i18n';
import './index.css';

// #646 §5.2: one-time cleanup of pre-v2 (0-10 scale) cached match scores.
// localStorage has no expiry of its own, and nothing reads a v1 key after the
// prefix bump, so without this they would sit in every browser forever.
sweepLegacyMatchScoreCache();

// AUTH-VULN-03/04: clear the access/refresh tokens the old build left in
// this browser. Nothing reads them any more, so they would otherwise sit
// there readable by any script on the origin.
purgeLegacyAuthStorage();

const queryClient = createQueryClient();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
