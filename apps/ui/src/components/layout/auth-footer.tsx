import { Link } from 'react-router-dom';
import { useNetworkTheme } from '@/theme/theme-provider';

export function AuthFooter() {
  const { theme } = useNetworkTheme();

  return (
    <footer className="px-6 pb-6 pt-4 sm:px-10 lg:px-14 text-xs text-muted-foreground">
      <p className="mb-3">
        By continuing you agree to the{' '}
        <Link
          // Both documents live on one page; the fragment is what picks
          // the section. `/privacy` still works — it redirects here.
          to="/legal#privacy"
          className="text-primary font-medium underline underline-offset-2 hover:opacity-80"
        >
          Privacy Policy
        </Link>{' '}
        and{' '}
        <Link
          to="/legal#terms"
          className="text-primary font-medium underline underline-offset-2 hover:opacity-80"
        >
          Terms
        </Link>
        .
      </p>
      <div className="flex items-center">
        <span>{theme.inviteLine}</span>
      </div>
    </footer>
  );
}
