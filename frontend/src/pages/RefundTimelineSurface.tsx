import { Link } from 'react-router-dom';
import { ArrowLeft, Clock } from 'lucide-react';
import { RefundTimelineSimulator } from '../components/RefundTimelineSimulator';

export default function RefundTimelineSurface() {
  return (
    <div className="app-shell min-h-screen text-white">
      <header className="border-b border-cyan-200/15 bg-[#050817]/78 backdrop-blur-2xl">
        <div className="mx-auto flex max-w-5xl flex-col gap-4 px-4 py-5 md:flex-row md:items-center md:justify-between md:px-8 md:py-6">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-cyan-200/25 bg-cyan-200/10 text-cyan-100">
              <Clock className="h-5 w-5" />
            </span>
            <div>
              <p className="text-[11px] uppercase tracking-[0.28em] text-cyan-100/70">
                OverSync v2
              </p>
              <h1 className="text-xl font-semibold text-white md:text-2xl">
                Refund Timeline Simulator
              </h1>
            </div>
          </div>
          <Link
            to="/"
            className="inline-flex items-center gap-2 self-start rounded-full border border-white/10 bg-white/[0.05] px-3 py-1.5 text-xs font-semibold text-slate-200 transition hover:border-cyan-200/35 hover:bg-cyan-200/10 hover:text-white md:self-auto"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to bridge
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl px-4 py-8 md:px-8 md:py-12">
        <p className="mb-6 text-sm leading-6 text-slate-300/90 md:text-base">
          Explore how HTLC refund timing works across Ethereum and Stellar.
          Select different scenarios to see when refunds and claims become
          available based on timelock expiry.
        </p>

        <RefundTimelineSimulator />
      </main>
    </div>
  );
}
