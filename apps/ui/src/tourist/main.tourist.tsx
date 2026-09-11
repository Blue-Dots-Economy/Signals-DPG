import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '@/lib/query-client';
import { purgeLegacyAuthStorage } from '@/lib/purge-legacy-auth-storage';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThemeModeProvider } from '@/theme/mode-provider';
import '../i18n';
import '../index.css';
import '@/components/map/providers';
import { TouristApp } from './tourist-app';
import { getRuntimeEnv } from '@/lib/runtime-env';
import { applyNetworkBrand } from '@/theme/theme-provider';
import { TOURIST_NETWORK_ID, TOURIST_BRAND } from './resolve-tourist-config';

// Apply network + brand to <html> (data-network/data-brand) and install the
// brand-aware favicon from the MODULE-resolved values. The inline HTML script
// only sets first-paint fallbacks because Vite `define` does not replace tokens
// inside classic inline <script> blocks. The tourist app has no
// NetworkThemeProvider, so without this the active brand's CSS + favicon never
// activate (data-brand stays 'standard').
const meta = applyNetworkBrand(TOURIST_NETWORK_ID, TOURIST_BRAND);

// Browser tab title — sources in order:
//   1. resolved brand copy.title (e.g. "OneTAC" when onetac brand is active)
//   2. VITE_TOURIST_APP_TITLE runtime/build env
//   3. neutral default 'Signals'
document.title = meta.copy.title || getRuntimeEnv('VITE_TOURIST_APP_TITLE')?.trim() || 'Signals';

// AUTH-VULN-03/04: clear the access/refresh tokens the old build left in
// this browser. Nothing reads them any more, so they would otherwise sit
// there readable by any script on the origin.
purgeLegacyAuthStorage();

const queryClient = createQueryClient();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeModeProvider>
      <TooltipProvider>
        <QueryClientProvider client={queryClient}>
          <TouristApp />
        </QueryClientProvider>
      </TooltipProvider>
    </ThemeModeProvider>
  </React.StrictMode>,
);
