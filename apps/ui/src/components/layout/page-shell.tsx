import type { RJSFSchema } from '@rjsf/utils';
import { useTranslation } from 'react-i18next';
import { SidebarProvider } from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import type { DotNetworkDomain, DotNetworkSchema, ViewMode } from '@/engine/types';
import type { Item } from '@/lib/item-api';
import { TopBar } from './top-bar';
import { AppSidebar } from './sidebar';

interface PageShellProps {
  children: React.ReactNode;
  /** 'browse' (default) shows search/filters/view-toggle; 'form' shows a Back button + title instead. Forwarded to `TopBar`. */
  variant?: 'browse' | 'form';
  /** Shown next to the Back button when `variant === 'form'`. */
  title?: string;
  /** Optional secondary line under `title` when `variant === 'form'`. */
  subtitle?: string;
  /** Invoked by the Back button when `variant === 'form'`. */
  onBack?: () => void;
  networks?: DotNetworkSchema[];
  selectedNetwork?: string | null;
  onNetworkSelect?: (networkId: string) => void;
  /**
   * Sidebar Browse group. Optional since #645 (spec D10): domain selection
   * moved out of the sidebar into the browse toolbar, so the browse page
   * passes `hideBrowse` and omits these. Form pages that still want the
   * group keep supplying them.
   */
  domains?: DotNetworkDomain[];
  selectedDomain?: string | null;
  onDomainSelect?: (domainId: string | null) => void;
  currentDomainLabel?: string;
  myItems?: Item[];
  activeProfileId?: string | null;
  onActiveProfileChange?: (profileId: string) => void;
  onProfilesChanged?: () => void;
  userSchemas?: Record<string, RJSFSchema>;
  search?: string;
  onSearchChange?: (value: string) => void;
  viewMode?: ViewMode;
  onViewModeChange?: (mode: ViewMode) => void;
  /**
   * Browse state bar (#644, spec §7.2) — domain, sort, area and the applied
   * filter chips. Rendered BETWEEN the top bar and the scroll area, as a
   * sibling of `<main>` rather than a `sticky` element inside it.
   *
   * That placement is the whole trick. `<main>` is the scroll container
   * (`overflow-y-auto` in an `h-svh` flex column), so anything outside it is
   * structurally pinned and needs no `sticky` and no `top-N` offset. A sticky
   * child of `<main>` would have needed an offset equal to the top bar's
   * height — and the top bar is `flex-wrap`, so its height changes with
   * viewport width and any hardcoded offset would gap or overlap.
   */
  toolbarSlot?: React.ReactNode;
  /** Label for the form-variant Back control (defaults to "Back" in TopBar). */
  backLabel?: string;
  /** Hide the sidebar's Browse (domain selector) group — form pages. */
  hideBrowse?: boolean;
  /** A pinned footer rendered BELOW the scroll area (not inside it). Used by the
   * form pages for the action bar so it stays fixed at the column bottom while
   * the form scrolls above it — a `sticky` element inside `<main>` floats when
   * the content is shorter than the viewport, which this avoids. */
  footerSlot?: React.ReactNode;
}

export function PageShell({
  children,
  variant,
  title,
  subtitle,
  onBack,
  networks,
  selectedNetwork,
  onNetworkSelect,
  domains,
  selectedDomain,
  onDomainSelect,
  currentDomainLabel,
  myItems,
  activeProfileId,
  onActiveProfileChange,
  onProfilesChanged,
  userSchemas,
  search,
  onSearchChange,
  viewMode,
  onViewModeChange,
  toolbarSlot,
  backLabel,
  hideBrowse,
  footerSlot,
}: Readonly<PageShellProps>) {
  const { t } = useTranslation();

  return (
    <TooltipProvider>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-md focus:bg-background focus:px-4 focus:py-2 focus:shadow"
      >
        {t('a11y.skip_to_content')}
      </a>
      <SidebarProvider>
        <AppSidebar
          networks={networks}
          selectedNetwork={selectedNetwork}
          onNetworkSelect={onNetworkSelect}
          domains={domains ?? []}
          selectedDomain={selectedDomain ?? null}
          onDomainSelect={onDomainSelect ?? (() => {})}
          currentDomainLabel={currentDomainLabel}
          myItems={myItems}
          activeProfileId={activeProfileId}
          onActiveProfileChange={onActiveProfileChange}
          onProfilesChanged={onProfilesChanged}
          userSchemas={userSchemas}
          hideBrowse={hideBrowse}
        />
        <div className="flex h-svh min-w-0 flex-1 flex-col">
          <TopBar
            variant={variant}
            title={title}
            subtitle={subtitle}
            onBack={onBack}
            backLabel={backLabel}
            search={search}
            onSearchChange={onSearchChange}
            viewMode={viewMode}
            onViewModeChange={onViewModeChange}
          />
          {toolbarSlot && (
            // `flex-none` so it keeps its natural height instead of being
            // squeezed by the flex column, matching `footerSlot` below.
            <div className="flex-none border-b bg-background">{toolbarSlot}</div>
          )}
          <main
            id="main-content"
            // `min-h-0` is load-bearing: without it a flex child defaults to
            // min-height:auto and refuses to shrink below its content, so a tall
            // form expands past the h-svh column and the whole page gets a second
            // (body) scrollbar instead of scrolling inside <main>.
            // `relative` is also load-bearing: it makes <main> the containing
            // block for absolutely-positioned descendants (e.g. cmdk's
            // visually-hidden `position:absolute` labels), so they anchor here and
            // are clipped by this scroll container — otherwise they anchor to the
            // initial containing block at their deep flow positions and stretch
            // the document, producing a phantom second (body) scrollbar.
            className="relative min-h-0 flex-1 overflow-y-auto p-4 max-md:overflow-x-clip sm:p-6"
          >
            {children}
          </main>
          {footerSlot && (
            <div className="flex-none border-t bg-background">{footerSlot}</div>
          )}
        </div>
      </SidebarProvider>
    </TooltipProvider>
  );
}
