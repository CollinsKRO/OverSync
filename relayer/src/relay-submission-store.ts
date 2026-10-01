/**
 * @fileoverview Durability for relay submission records.
 *
 * `relay-submission-tracker.ts` refuses to broadcast a second transaction for
 * an (order, side, action) triple, but an in-memory map forgets everything on
 * restart. That turns a redeploy into a double-spend: the relayer comes back up,
 * sees no record, and pays an order whose transaction already confirmed.
 *
 * The store closes that hole. It is intentionally tiny and synchronous — the
 * write volume is a handful of records per swap, and a synchronous atomic
 * rename is the only way to guarantee there is no window where a crash loses
 * the hash we just recorded but had not yet broadcast.
 *
 * Records are pruned so the file cannot grow without bound: every non-terminal
 * record is always kept, terminal ones are kept newest-first up to `maxRecords`.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/** Current on-disk schema version. Bump when the shape changes. */
export const STORE_SCHEMA_VERSION = 1;

export interface PersistedSubmission {
  version: number;
  /** `<side>:<action>:<orderId>#<digest>` — the single-flight key. */
  key: string;
  /** `<orderId>|<side>#<digest>` — the order-level lock scope. */
  orderKey: string;
  orderId: string;
  side: string;
  action: string;
  chain: string;
  network?: string;
  txHash?: string;
  status: 'in_flight' | 'pending' | 'succeeded' | 'failed';
  attempts: number;
  maxAttempts: number;
  /** How many broadcasts this key produced. Must be 0 or 1. */
  broadcasts: number;
  lastError?: string;
  /** Why the record became `failed`, so a restart keeps the same semantics. */
  terminalReason?: 'failed' | 'not_found' | 'non_retryable' | 'staging_failed';
  result?: unknown;
  firstSeenAt: number;
  lastAttemptAt?: number;
  completedAt?: number;
}

/**
 * Persistence backend for the relay submission tracker.
 *
 * Synchronous on purpose: the tracker calls `save` between "record the hash"
 * and "broadcast", and an async write would reopen exactly the crash window
 * this store exists to close.
 */
export interface RelaySubmissionStore {
  /** Read all persisted records. Must return `[]` when nothing is stored. */
  load(): PersistedSubmission[];
  /** Atomically replace the persisted set. */
  save(entries: PersistedSubmission[]): void;
}

/** In-memory store. Useful for tests and for running without a disk. */
export class MemoryRelaySubmissionStore implements RelaySubmissionStore {
  private entries: PersistedSubmission[];

  constructor(initial: PersistedSubmission[] = []) {
    this.entries = initial.map(entry => ({ ...entry }));
  }

  load(): PersistedSubmission[] {
    return this.entries.map(entry => ({ ...entry }));
  }

  save(entries: PersistedSubmission[]): void {
    this.entries = entries.map(entry => ({ ...entry }));
  }
}

export interface FileRelaySubmissionStoreOptions {
  /** Absolute or cwd-relative path of the JSON file. */
  filePath: string;
  /**
   * Maximum number of *terminal* records kept. Default 500. Non-terminal
   * records (`in_flight`, `pending`) are never pruned — they are the ones that
   * keep an order locked across a restart.
   */
  maxRecords?: number;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

const DEFAULT_MAX_RECORDS = 500;

/**
 * JSON-file backed store with an atomic write (temp file + rename), so a crash
 * mid-write can never leave a half-written file that loses a transaction hash.
 */
export class FileRelaySubmissionStore implements RelaySubmissionStore {
  private readonly filePath: string;
  private readonly maxRecords: number;
  private readonly logger?: Pick<Console, 'log' | 'warn' | 'error'>;

  constructor(options: FileRelaySubmissionStoreOptions) {
    this.filePath = resolve(options.filePath);
    this.maxRecords = Math.max(1, Math.floor(options.maxRecords ?? DEFAULT_MAX_RECORDS));
    this.logger = options.logger;
  }

  get path(): string {
    return this.filePath;
  }

  /**
   * Tolerant read: a missing file is an empty store and a corrupt file is
   * reported and treated as empty. Losing the file is bad, but refusing to
   * start (and therefore refusing to relay at all) is worse.
   */
  load(): PersistedSubmission[] {
    if (!existsSync(this.filePath)) return [];
    let raw: string;
    try {
      raw = readFileSync(this.filePath, 'utf8');
    } catch (err) {
      this.logger?.error?.(
        `❌ relay-submission-store: could not read ${this.filePath}:`,
        err instanceof Error ? err.message : String(err)
      );
      return [];
    }
    if (!raw.trim()) return [];

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.logger?.error?.(
        `❌ relay-submission-store: ${this.filePath} is not valid JSON; treating as empty. ` +
          'Move the file aside to let the relayer relay again.'
      );
      return [];
    }

    const entries = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { submissions?: unknown })?.submissions)
        ? (parsed as { submissions: unknown[] }).submissions
        : null;
    if (!entries) {
      this.logger?.error?.(
        `❌ relay-submission-store: ${this.filePath} has an unexpected shape; treating as empty`
      );
      return [];
    }
    return entries.filter(
      (entry): entry is PersistedSubmission =>
        !!entry && typeof entry === 'object' && typeof (entry as PersistedSubmission).key === 'string'
    );
  }

  save(entries: PersistedSubmission[]): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const kept = this.prune(entries);
    const payload = `${JSON.stringify({ version: STORE_SCHEMA_VERSION, submissions: kept }, null, 2)}\n`;
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    try {
      writeFileSync(tmpPath, payload, 'utf8');
      renameSync(tmpPath, this.filePath);
    } catch (err) {
      try {
        if (existsSync(tmpPath)) unlinkSync(tmpPath);
      } catch {
        // Best effort only — the tracker already treats store failures as
        // non-fatal, so there is nothing further to do here.
      }
      this.logger?.error?.(
        `❌ relay-submission-store: could not write ${this.filePath}:`,
        err instanceof Error ? err.message : String(err)
      );
      throw err;
    }
  }

  /** Keep every non-terminal record, plus the newest terminal ones. */
  private prune(entries: PersistedSubmission[]): PersistedSubmission[] {
    const live = entries.filter(e => e.status === 'in_flight' || e.status === 'pending');
    const terminal = entries
      .filter(e => e.status !== 'in_flight' && e.status !== 'pending')
      .sort((a, b) => (b.completedAt ?? b.lastAttemptAt ?? b.firstSeenAt) - (a.completedAt ?? a.lastAttemptAt ?? a.firstSeenAt));
    return [...live, ...terminal.slice(0, this.maxRecords)];
  }
}
