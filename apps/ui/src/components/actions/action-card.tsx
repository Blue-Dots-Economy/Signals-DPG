import * as React from 'react';
import { formatDistanceToNow } from 'date-fns';
import {
  ChevronDown,
  Check,
  X,
  CheckCircle2,
  Clock,
  AlertCircle,
  Sparkles,
  ArrowRight,
  MessageSquare,
  UserRound,
  MapPin,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { Action } from '@/lib/action-api';
import { ProfileCardModal } from '@/components/actions/profile-card-modal';
import { MatchScoreBadge } from '@/components/match-score/match-score-badge';
import { formatDomainLabel } from '@/lib/domain-icons';
import { useNetworkConfig } from '@/hooks/use-network-config';

interface ActionCardProps {
  action: Action;
  ownershipRole: 'initiated' | 'received';
  onStatusUpdate?: (action: Action, targetStatus: string) => void;
  /** When true, hide the action footer (the card is a selection target). */
  selectionMode?: boolean;
}

type StatusStyleShape = {
  labelKey: string | null;
  cls: string;
  dot: string;
  icon: React.ReactNode;
};

// Status pill: dot + label on a soft tint. Semantic colours (not brand) so
// state reads consistently across networks. Labels are i18n keys; the
// component resolves them via t() so non-English locales render correctly.
const statusStyles: Record<string, StatusStyleShape> = {
  created: { labelKey: 'actions.status_pill_pending', cls: 'bg-amber-50 text-amber-700', dot: 'bg-amber-500', icon: <Clock className="h-3 w-3" /> },
  pending: { labelKey: 'actions.status_pill_pending', cls: 'bg-amber-50 text-amber-700', dot: 'bg-amber-500', icon: <Clock className="h-3 w-3" /> },
  new: { labelKey: 'actions.status_pill_new', cls: 'bg-primary/10 text-primary', dot: 'bg-primary', icon: <Sparkles className="h-3 w-3" /> },
  accepted: { labelKey: 'actions.status_pill_accepted', cls: 'bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500', icon: <Check className="h-3 w-3" /> },
  completed: { labelKey: 'actions.status_pill_completed', cls: 'bg-emerald-50 text-emerald-700', dot: 'bg-emerald-500', icon: <CheckCircle2 className="h-3 w-3" /> },
  rejected: { labelKey: 'actions.status_pill_rejected', cls: 'bg-red-50 text-red-700', dot: 'bg-red-500', icon: <X className="h-3 w-3" /> },
  cancelled: { labelKey: 'actions.status_pill_cancelled', cls: 'bg-slate-100 text-slate-600', dot: 'bg-slate-400', icon: <AlertCircle className="h-3 w-3" /> },
};

function getStatusStyle(status: string): StatusStyleShape {
  return (
    statusStyles[status] ?? {
      labelKey: null,
      cls: 'bg-slate-100 text-slate-600',
      dot: 'bg-slate-400',
      icon: null,
    }
  );
}

function formatItemLocations(locs: Array<{ lat: number; lng: number; label?: string }> | undefined): string {
  if (!locs || locs.length === 0) return '';
  const labels = locs.map((l) => l.label).filter((s): s is string => !!s && s.trim().length > 0);
  return labels.length > 0 ? labels.join(', ') : `${locs.length} location${locs.length > 1 ? 's' : ''}`;
}

function formatDistanceKm(distanceM: number): string {
  return `${(distanceM / 1000).toFixed(1)} km`;
}

function formatRequirementValue(value: unknown): string {
  if (value == null) return '—';
  if (Array.isArray(value)) return value.map((v) => String(v)).join(', ');
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

const titleCase = (s: string) =>
  s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

export function ActionCard({ action, ownershipRole, onStatusUpdate, selectionMode = false }: ActionCardProps) {
  const { t } = useTranslation();
  const [showRequirements, setShowRequirements] = React.useState(true);
  const [showProfile, setShowProfile] = React.useState(false);

  const status = getStatusStyle(action.action_status);

  // Resolve the "other party" vs "me" from ownership.
  const otherParty =
    ownershipRole === 'initiated'
      ? {
          name: action.target_item_name,
          itemId: action.target_item_id,
          domain: action.target_item_domain,
          itemType: action.target_item_type,
          network: action.target_item_network,
          locations: action.target_item_locations,
        }
      : {
          name: action.source_item_name,
          itemId: action.source_item_id,
          domain: action.source_item_domain,
          itemType: action.source_item_type,
          network: action.source_item_network,
          locations: action.source_item_locations,
        };
  const myDomain =
    ownershipRole === 'initiated' ? action.source_item_domain : action.target_item_domain;

  const { data: acNetworkConfig } = useNetworkConfig(otherParty.network ?? null);
  const otherRole = formatDomainLabel(otherParty.domain, acNetworkConfig?.domains);
  const myRole = formatDomainLabel(myDomain, acNetworkConfig?.domains);
  const hasRealName = !!otherParty.name && otherParty.name !== otherParty.itemId;
  const rawName = hasRealName
    ? otherParty.name!
    : `#${otherParty.itemId.slice(0, 6)}`;
  // Avatar: first letter of a real name, else the role's initial.
  const initial = (hasRealName ? rawName : otherRole).charAt(0).toUpperCase() || '?';

  // Both sides format as "<Subject> (<Role>)" so the brackets consistently
  // contain the role on each end — avoids the mismatch where "You (Seeker)"
  // had role-in-brackets while "Provider (Name)" had name-in-brackets.
  const meLabel = t('actions.you_label', { role: myRole });
  const otherLabel = `${rawName} (${otherRole})`;
  const fromLabel = ownershipRole === 'initiated' ? meLabel : otherLabel;
  const toLabel = ownershipRole === 'initiated' ? otherLabel : meLabel;

  const location = formatItemLocations(otherParty.locations) || null;

  const isPending =
    action.action_status === 'created' || action.action_status === 'pending';
  const canAccept = ownershipRole === 'received' && isPending;
  const canReject = ownershipRole === 'received' && isPending;
  const canComplete = ownershipRole === 'received' && action.action_status === 'accepted';
  const canCancel = ownershipRole === 'initiated' && isPending;

  // Message + structured requirement fields split out of the snapshot.
  const reqEntries = Object.entries(action.requirements_snapshot);
  const messageEntry = reqEntries.find(([k]) => k.toLowerCase() === 'message');
  const fieldEntries = reqEntries.filter(([k]) => k.toLowerCase() !== 'message');
  const message =
    messageEntry && typeof messageEntry[1] === 'string' ? messageEntry[1] : null;
  const hasRequirements = reqEntries.length > 0;

  return (
    <div className="group relative overflow-hidden rounded-[18px] border bg-card shadow-sm transition-all duration-200 hover:shadow-md">
      {/* Top accent strip — brand gradient */}
      <div className="h-[3px] w-full bg-gradient-to-r from-primary/40 via-primary to-primary/70" />

      <div className="p-5">
        {/* Row 1: status badge + time. */}
        <div className="mb-4 flex items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold ${status.cls}`}>
              <span className={`h-1.5 w-1.5 rounded-full ${status.dot}`} />
              {status.labelKey ? t(status.labelKey) : action.action_status}
            </span>
            {action.match_score != null ? (
              // #646: My Actions shows a connect-time relevance SNAPSHOT, not
              // a browse-list metric — there is no sort here, so the basis is
              // always the profile match. The column is 0-10 (see
              // compute_match_score) while the pill renders 0-100.
              <MatchScoreBadge
                metric={{ kind: 'relevance', percent: action.match_score * 10 }}
                basis="profile"
                size="sm"
              />
            ) : (
              <span className="inline-flex items-center rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-500">
                {t('actions.not_scored_yet', 'Not scored yet')}
              </span>
            )}
          </div>
          <span className="whitespace-nowrap text-xs font-medium text-muted-foreground">
            {formatDistanceToNow(new Date(action.created_at), { addSuffix: true })}
          </span>
        </div>

        {/* Row 2: identity */}
        <div className="mb-4 flex items-center gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-base font-bold text-primary ring-1 ring-black/5">
            {initial}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm font-semibold leading-snug text-foreground [overflow-wrap:anywhere]">
              <span>{fromLabel}</span>
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-primary/70" />
              <span>{toLabel}</span>
            </div>
          </div>
        </div>

        {/* Requirements */}
        {hasRequirements && (
          <>
            <button
              type="button"
              onClick={() => setShowRequirements((o) => !o)}
              className="flex w-full items-center justify-between border-t py-2.5"
            >
              <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-muted-foreground">
                {t('actions.requirements')}
              </span>
              <ChevronDown
                className={`h-4 w-4 text-muted-foreground transition-transform ${showRequirements ? 'rotate-180' : ''}`}
              />
            </button>

            {showRequirements && (
              <div className="mb-4 rounded-xl border bg-muted/50 p-3.5">
                {message && (
                  <div className="mb-3 flex items-start gap-3 border-b pb-3">
                    <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-card text-primary shadow-sm">
                      <MessageSquare className="h-3.5 w-3.5" />
                    </div>
                    <div className="min-w-0">
                      <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                        {t('actions.message_label')}
                      </p>
                      <p className="text-[13px] leading-relaxed text-foreground [overflow-wrap:anywhere]">
                        {message}
                      </p>
                    </div>
                  </div>
                )}

                {fieldEntries.map(([key, value]) => (
                  <div
                    key={key}
                    className="grid grid-cols-1 gap-2 py-1.5 sm:grid-cols-[120px_1fr] sm:items-start sm:gap-3"
                  >
                    <div className="pt-1 text-xs font-medium text-muted-foreground">
                      {titleCase(key)}
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {Array.isArray(value) ? (
                        value.length === 0 ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : (
                          value.map((v, i) => (
                            <span
                              key={i}
                              className="inline-flex items-center rounded-lg bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary"
                            >
                              {String(v)}
                            </span>
                          ))
                        )
                      ) : (
                        <span className="text-[13px] text-foreground [overflow-wrap:anywhere]">
                          {formatRequirementValue(value)}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {/* Reason attached to a rejected/cancelled action — the actor's remark,
            or a system remark (e.g. counterparty retired, #347). Rendered at the
            card level so it shows even when the action has no requirements. */}
        {action.remarks && (
          <div className="mb-3 rounded-xl border border-border bg-muted/40 p-3.5">
            <p className="mb-0.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t('actions.reason_shown_label', 'Reason')}
            </p>
            <p className="text-[13px] leading-relaxed text-foreground [overflow-wrap:anywhere]">
              {action.remarks}
            </p>
          </div>
        )}

        {location && (
          <div className="mb-3 flex items-center gap-1.5 text-xs text-muted-foreground">
            <MapPin className="h-3 w-3" />
            <span>{location}</span>
          </div>
        )}

        {action.distance_m != null && (
          <div className="mb-3 flex items-center gap-1.5 text-xs text-muted-foreground">
            <MapPin className="h-3 w-3" />
            <span>{formatDistanceKm(action.distance_m)}</span>
          </div>
        )}

        {/* Actions */}
        {!selectionMode && (
        <div className="flex flex-wrap items-center gap-2 border-t pt-3">
          {/* Always available (both roles, every status): the counterparty's
              profile — masked while pending, unmasked once PII is revealed
              (accepted/completed). Handled inside ProfileCardModal. */}
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            onClick={() => setShowProfile(true)}
          >
            <UserRound className="mr-1.5 h-3.5 w-3.5" />
            {t('actions.btn_view_profile')}
          </Button>

          {canAccept && (
            <Button size="sm" className="flex-1 shadow-sm" onClick={() => onStatusUpdate?.(action, 'accepted')}>
              <Check className="mr-1.5 h-3.5 w-3.5" />
              {t('actions.btn_accept')}
            </Button>
          )}
          {canReject && (
            <Button size="sm" variant="outline" className="flex-1" onClick={() => onStatusUpdate?.(action, 'rejected')}>
              <X className="mr-1.5 h-3.5 w-3.5" />
              {t('actions.btn_reject')}
            </Button>
          )}
          {canComplete && (
            <Button size="sm" className="flex-1 shadow-sm" onClick={() => onStatusUpdate?.(action, 'completed')}>
              <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
              {t('actions.btn_complete')}
            </Button>
          )}
          {canCancel && (
            <Button size="sm" variant="outline" className="flex-1" onClick={() => onStatusUpdate?.(action, 'cancelled')}>
              <X className="mr-1.5 h-3.5 w-3.5 text-destructive" />
              {t('actions.btn_cancel')}
            </Button>
          )}
        </div>
        )}
      </div>

      <ProfileCardModal
        open={showProfile}
        onOpenChange={setShowProfile}
        actionId={action.action_id}
        actionStatus={action.action_status}
        counterparty={{
          // Fall back to the role (e.g. "Provider") for nameless profiles
          // instead of the raw #id, matching the button's reasoning.
          name: hasRealName ? rawName : otherRole,
          itemId: otherParty.itemId,
          itemNetwork: otherParty.network,
          itemDomain: otherParty.domain,
          itemType: otherParty.itemType,
        }}
      />
    </div>
  );
}
