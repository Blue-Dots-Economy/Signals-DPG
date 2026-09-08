import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '@/lib/query-client';
import { sweepLegacyMatchScoreCache } from '@/utils/match-score-cache';
import { App } from './app';
import '@/components/wallet/providers';
import './i18n';
import './index.css';

// #646 §5.2: one-time cleanup of pre-v2 (0-10 scale) cached match scores.
// localStorage has no expiry of its own, and nothing reads a v1 key after the
// prefix bump, so without this they would sit in every browser forever.
sweepLegacyMatchScoreCache();

const queryClient = createQueryClient();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </React.StrictMode>,
);
