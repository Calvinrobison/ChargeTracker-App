/**
 * The collection warning.
 *
 * It must never take over the screen: the map, the list and the history stay
 * usable while a source is paused. Affected stations show their last known
 * observation rather than pretending to be fresh.
 */

import type { ReactNode } from 'react';

import type { SourceHealthView } from '../../../shared/ipc.ts';
import { WarningIcon } from './Icons.tsx';

export interface WarningBannerProps {
  readonly source: SourceHealthView;
  readonly variant: 'rail' | 'strip';
  readonly onRetry?: () => void;
  readonly onViewDetails: () => void;
  readonly onDismiss: () => void;
  readonly retrying?: boolean;
}

/** A source worth warning about: paused, blocked, broken or never verified. */
export function needsWarning(source: SourceHealthView): boolean {
  if (source.eligibilityState !== 'enabled') return true;
  return source.state === 'paused' || source.state === 'blocked' || source.state === 'circuit_open';
}

function headline(source: SourceHealthView): string {
  if (source.eligibilityState !== 'enabled') {
    return `${source.displayName} collection is not enabled`;
  }
  if (source.state === 'blocked') return `${source.displayName} refused automated access`;
  if (source.state === 'circuit_open') return `${source.displayName} is not responding`;
  return `${source.displayName} collection paused`;
}

function body(source: SourceHealthView): string {
  if (source.message) return source.message;
  if (source.eligibilityState !== 'enabled') {
    return 'No observations can be recorded from this source until its eligibility has been established. History and last known observations remain available.';
  }
  return 'The source page changed and could not be read. History and last known observations remain available.';
}

export function WarningBanner({
  source,
  variant,
  onRetry,
  onViewDetails,
  onDismiss,
  retrying = false,
}: WarningBannerProps): ReactNode {
  // A source that is not eligible cannot be retried: retrying would be a
  // request we are not permitted to make. Only a real fault offers Try again.
  const canRetry = source.eligibilityState === 'enabled' && onRetry !== undefined;

  return (
    <div
      className={variant === 'rail' ? 'warning-banner' : 'warning-banner warning-banner--strip'}
      role="status"
    >
      <span className="warning-icon">
        <WarningIcon size={15} title="Warning" />
      </span>
      <div className="warning-copy">
        <span className="warning-title">{headline(source)}</span>
        <span className="warning-body">{body(source)}</span>
        {source.userAction ? <span className="warning-body">{source.userAction}</span> : null}
        {variant === 'rail' ? (
          <span className="warning-actions">
            {canRetry ? (
              <button
                type="button"
                className="button-warning"
                onClick={onRetry}
                disabled={retrying}
              >
                {retrying ? 'Trying…' : 'Try again'}
              </button>
            ) : null}
            <button type="button" className="button-outline" onClick={onViewDetails}>
              View details
            </button>
            <button type="button" className="button-text" onClick={onDismiss}>
              Dismiss
            </button>
          </span>
        ) : null}
      </div>
      {variant === 'strip' ? (
        <>
          <span className="spacer" />
          <span className="warning-actions" style={{ marginTop: 0 }}>
            <button type="button" className="button-outline" onClick={onViewDetails}>
              View details
            </button>
            {canRetry ? (
              <button
                type="button"
                className="button-warning"
                onClick={onRetry}
                disabled={retrying}
              >
                {retrying ? 'Trying…' : 'Try again'}
              </button>
            ) : null}
          </span>
        </>
      ) : null}
    </div>
  );
}
