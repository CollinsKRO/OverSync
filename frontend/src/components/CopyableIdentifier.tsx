import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, X } from 'lucide-react';

type CopyState = 'idle' | 'copied' | 'error';

export interface CopyableIdentifierProps {
  /** Full raw value written to the clipboard. */
  value: string;
  /** Optional visible text; when omitted, derived from `value` (and truncation settings). */
  displayText?: string;
  /** Shorten visible text while copying the full `value`. */
  truncate?: boolean;
  truncateHead?: number;
  truncateTail?: number;
  /** Accessible name for the copy control (e.g. "transaction hash"). */
  copyLabel: string;
  /** When true, only render the copy control (no visible identifier text). */
  hideDisplay?: boolean;
  className?: string;
  textClassName?: string;
  mono?: boolean;
}

const TX_HASH = /^(0x[0-9a-fA-F]{64}|[0-9a-fA-F]{64})$/;
const ORDER_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;
const STELLAR_SECRET = /^S[A-Z2-7]{55}$/;

/** Order id or transaction hash only. URLs, preimages, and secrets are refused. */
export function copyablePublicIdentifier(value: string): string | null {
  if (!value || value.includes('://')) return null;
  if (STELLAR_SECRET.test(value) || /preimage|secret/i.test(value)) return null;
  if (TX_HASH.test(value) || ORDER_ID.test(value)) return value;
  return null;
}

export async function copyPublicIdentifier(
  value: string,
  write: (text: string) => Promise<void>,
): Promise<{ copied: boolean }> {
  const allowed = copyablePublicIdentifier(value);
  if (!allowed) return { copied: false };
  await write(allowed);
  return { copied: true };
}

function truncateMiddle(text: string, head: number, tail: number): string {
  if (text.length <= head + tail + 3) return text;
  return `${text.slice(0, head)}...${text.slice(-tail)}`;
}

export async function copyTextToClipboard(text: string): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
    throw new Error('Clipboard API unavailable');
  }
  await navigator.clipboard.writeText(text);
}

export function CopyableIdentifier({
  value,
  displayText,
  truncate = false,
  truncateHead = 10,
  truncateTail = 8,
  copyLabel,
  hideDisplay = false,
  className = '',
  textClassName = '',
  mono = true,
}: CopyableIdentifierProps) {
  const [state, setState] = useState<CopyState>('idle');
  const resetTimerRef = useRef<number | null>(null);

  const visibleText =
    displayText ??
    (truncate ? truncateMiddle(value, truncateHead, truncateTail) : value);

  const handleCopy = useCallback(async () => {
    const allowed = copyablePublicIdentifier(value);
    if (!allowed) {
      setState('error');
      return;
    }
    try {
      await copyTextToClipboard(allowed);
      setState('copied');
      window.dispatchEvent(
        new CustomEvent('oversync-toast', {
          detail: {
            type: 'success',
            title: 'Copied!',
            message: `${copyLabel.charAt(0).toUpperCase() + copyLabel.slice(1)} copied to clipboard.`,
            duration: 3000,
          },
        })
      );
    } catch {
      setState('error');
    }

    if (resetTimerRef.current !== null) {
      window.clearTimeout(resetTimerRef.current);
    }
    resetTimerRef.current = window.setTimeout(() => setState('idle'), 2000);
  }, [value, copyLabel]);

  useEffect(
    () => () => {
      if (resetTimerRef.current !== null) {
        window.clearTimeout(resetTimerRef.current);
      }
    },
    []
  );

  const statusMessage =
    state === 'copied' ? 'Copied' : state === 'error' ? 'Copy failed' : '';

  return (
    <span className={`inline-flex min-w-0 items-center gap-1 ${className}`}>
      {!hideDisplay && (
        <span className={`min-w-0 ${mono ? 'font-mono' : ''} ${textClassName}`}>{visibleText}</span>
      )}
      <span className="relative inline-flex h-6 w-6 shrink-0 items-center justify-center">
        <button
          type="button"
          onClick={() => void handleCopy()}
          className="inline-flex h-6 w-6 items-center justify-center rounded border border-white/10 bg-white/[0.045] text-slate-300 transition hover:bg-white/[0.08] hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-cyan-300/70"
          aria-label={`Copy ${copyLabel}`}
          title={`Copy ${copyLabel}`}
        >
          {state === 'copied' && <Check className="h-3.5 w-3.5 text-emerald-400" aria-hidden="true" />}
          {state === 'error' && <X className="h-3.5 w-3.5 text-red-400" aria-hidden="true" />}
          {state === 'idle' && <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
        </button>
        <span className="sr-only" aria-live="polite">
          {statusMessage}
        </span>
      </span>
    </span>
  );
}

export default CopyableIdentifier;
