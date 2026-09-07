import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'sonner';
import { RequireAuth } from '@/components/auth/require-auth';
import { WrongPortalToast } from '@/components/auth/wrong-portal-toast';
import { AuthProvider } from '@/contexts/auth-context';
import { NetworkThemeProvider } from '@/theme/theme-provider';
import { ThemeModeProvider } from '@/theme/mode-provider';
import { HomePage } from './pages/home-page';
import { ProfileFormPage } from './pages/profile-form-page';
import { LoginPage } from './pages/auth/login-page';
import { OtpPage } from './pages/auth/otp-page';
import { OidcCallbackPage } from './pages/auth/oidc-callback-page';
import { MyActionsPage } from './pages/my-actions-page';
import { LegalPage } from './pages/legal/legal-page';
import { PublicProfilePage } from './pages/public-profile-page';

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
       <ThemeModeProvider>
        <NetworkThemeProvider>
          <Toaster
            position="top-center"
            richColors
            closeButton
            offset={20}
            toastOptions={{ duration: 5000 }}
          />
          {/* Reports a domain-gate bounce that survived the Keycloak logout
              redirect. Mounted here, outside <Routes>, because that redirect
              lands on the site root rather than the login page. */}
          <WrongPortalToast />
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/profile/new" element={<RequireAuth><ProfileFormPage /></RequireAuth>} />
            <Route path="/profile/:id/edit" element={<RequireAuth><ProfileFormPage /></RequireAuth>} />
            <Route path="/auth/login" element={<LoginPage />} />
            <Route path="/auth/otp" element={<OtpPage />} />
            {/* Keycloak redirect target. Registered unconditionally so the
                route exists the moment VITE_AUTH_PROVIDER is flipped, without
                a rebuild — the page is inert if nobody redirects here. */}
            <Route path="/auth/callback" element={<OidcCallbackPage />} />
            <Route path="/legal" element={<LegalPage />} />
            {/* Both documents live on one page now. These two paths are what
                operators have already shared over SMS and email (see #637), so
                they keep working — as redirects that carry the reader to the
                right section of it. */}
            <Route path="/privacy" element={<Navigate to="/legal#privacy" replace />} />
            <Route path="/terms" element={<Navigate to="/legal#terms" replace />} />
            <Route path="/public/:network/:domain/:itemType/:itemId" element={<PublicProfilePage />} />
            <Route path="/my-actions" element={<RequireAuth><MyActionsPage /></RequireAuth>} />
            <Route path="/my-actions/*" element={<RequireAuth><MyActionsPage /></RequireAuth>} />
          </Routes>
        </NetworkThemeProvider>
       </ThemeModeProvider>
      </BrowserRouter>
    </AuthProvider>
  );
}
