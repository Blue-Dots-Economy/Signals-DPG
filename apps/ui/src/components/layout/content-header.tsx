import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { UserPlus } from 'lucide-react';

interface ContentHeaderProps {
  /**
   * Optional since #645. The browse page omits it: the toolbar's domain
   * control (or its "Showing <domain>" label when only one is selectable)
   * already names what is on screen, and this heading was BOTH a duplicate of
   * that and wrong on the map, where it showed a single domain while several
   * were selected.
   */
  title?: string;
  description?: string;
  count?: number;
  noProfilePrompt?: { show: boolean; networkId: string };
  /** Optional controls rendered on the right of the title row (e.g. Filters). */
  actions?: ReactNode;
}

export function ContentHeader({
  title,
  description,
  count,
  noProfilePrompt,
  actions,
}: Readonly<ContentHeaderProps>) {
  const { t } = useTranslation();

  // Render NOTHING when there is nothing to show. Since #645 stripped the
  // title, description and count out of this header, a signed-in viewer who
  // already has a profile left every slot empty — and the wrapper's `mb-6`
  // then drew a dead band between the filter bar and the results.
  const hasContent =
    Boolean(title) ||
    count !== undefined ||
    Boolean(description) ||
    Boolean(actions) ||
    Boolean(noProfilePrompt?.show);
  if (!hasContent) return null;

  return (
    <div className="mb-6 space-y-3">
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          {(title || count !== undefined) && (
            <div className="flex items-center gap-2 flex-wrap">
              {title && (
                <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
              )}
              {count !== undefined && count > 0 && (
                <span className="shrink-0 rounded-full bg-primary/10 text-primary text-xs font-medium px-2 py-0.5 leading-none">
                  {t('header.listings', { count })}
                </span>
              )}
            </div>
          )}
          {description && (
            <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {actions && <div className="shrink-0">{actions}</div>}
      </div>
      {noProfilePrompt?.show && (
        <div className="flex items-center justify-between gap-4 rounded-lg border border-primary/15 bg-primary/5 px-4 py-3">
          <p className="text-sm text-foreground/80">
            {t('header.no_profile_prompt')}
          </p>
          <Button
            asChild
            size="sm"
            variant="outline"
            className="shrink-0 border-primary/30 text-primary hover:bg-primary/10"
          >
            <Link to={`/profile/new?network=${noProfilePrompt.networkId}`}>
              <UserPlus className="h-3.5 w-3.5 mr-1.5" />
              {t('header.create_profile_cta')}
            </Link>
          </Button>
        </div>
      )}
    </div>
  );
}
