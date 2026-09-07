import { LegalDocumentView } from './legal-document-view';

/**
 * `/legal` — both consent documents on one page. `/privacy` and `/terms`
 * redirect here with a fragment (see `app.tsx`); which section the reader
 * lands on is decided by that fragment, not by the route.
 */
export function LegalPage() {
  return <LegalDocumentView />;
}
