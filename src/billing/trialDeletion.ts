import type pg from "pg";

/**
 * Phase 10 part 2b: deleting an unpaid trial's data (db/migrations/0041_trial_deletion.sql).
 *
 * The worker emails the firm's owners 14, 7 and 1 days before the deletion date, then deletes the firm once the
 * database says it is due (date reached, every warning sent in time, checked again under a lock), then deletes
 * the firm's files. Off unless HUIS_TRIAL_DELETION=on: Tracy turns it on once the terms of service and privacy
 * policy say so. With no email service set up, warnings wait and nothing is ever deleted.
 */
export interface EmailMessage { to: string; subject: string; text: string }

export interface EmailSender {
  readonly name: string;
  send(message: EmailMessage): Promise<void>;
}

/** Only the firm-prefix deletion of the file store is needed here. */
export interface FirmFileDeleter { deleteFirmPrefix(prefix: string): Promise<void> }

export function trialDeletionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.HUIS_TRIAL_DELETION === "on";
}

interface ClaimedNotice { notice_id: string; email: string; firm_name: string; delete_after: string | Date; time_zone: string; days_before: number }

function longDate(at: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone }).format(at);
  } catch {
    return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" }).format(at);
  }
}

/** The warning email. Account information only: the firm's name and the date, never anything from a Matter. */
export function deletionNotice(n: Pick<ClaimedNotice, "email" | "firm_name" | "delete_after" | "time_zone" | "days_before">, baseUrl: string): EmailMessage {
  const date = longDate(new Date(n.delete_after), n.time_zone);
  const when = n.days_before === 1 ? "tomorrow" : `in ${n.days_before} days`;
  const link = `${baseUrl.replace(/\/$/, "")}/subscription`;
  const firm = n.firm_name.replace(/[\r\n]+/g, " ").slice(0, 200);
  return {
    to: n.email,
    subject: `Huis Law: ${firm}'s trial data will be deleted on ${date}`,
    text: [
      `${firm}'s free trial of Huis Law ended without a subscription.`,
      "",
      `On ${date} (${when}), Huis will permanently delete the firm's account and everything in it: Matters, documents, emails, notes and people. This can't be undone.`,
      "",
      "To keep everything, subscribe before then:",
      link,
      "",
      "To keep a copy without subscribing, sign in and export each Matter before that date.",
      "",
      "Firms that have subscribed are never deleted for non-payment. If you think this is a mistake, reply to this email.",
    ].join("\n"),
  };
}

export class TrialDeletionWorker {
  private lastQueued = 0;

  constructor(
    private readonly pool: pg.Pool,
    private readonly files: FirmFileDeleter,
    private readonly email: EmailSender | null,
    private readonly baseUrl: string,
    private readonly enabled = trialDeletionEnabled(),
    private readonly queueEveryMs = 10 * 60_000,
  ) {}

  /** Queues warnings that are due (at most every few minutes). */
  async queueDue(force = false): Promise<number> {
    if (!force && Date.now() - this.lastQueued < this.queueEveryMs) return 0;
    this.lastQueued = Date.now();
    const r = await this.pool.query<{ n: number }>("SELECT huis.worker_queue_deletion_notices() AS n");
    if (this.email) await this.pool.query("SELECT huis.worker_retry_waiting_deletion_notices()");
    return r.rows[0]?.n ?? 0;
  }

  /** Sends one warning. Returns false when none is waiting. */
  async sendOnce(): Promise<boolean> {
    const n = (await this.pool.query<ClaimedNotice>("SELECT * FROM huis.worker_claim_deletion_notice()")).rows[0];
    if (!n) return false;
    if (!this.email) {
      await this.pool.query("SELECT huis.worker_finish_deletion_notice($1, 'waiting_for_provider', $2)", [n.notice_id, "No email sending service is set up yet"]);
      return true;
    }
    try {
      await this.email.send(deletionNotice(n, this.baseUrl));
      await this.pool.query("SELECT huis.worker_finish_deletion_notice($1, 'sent', NULL)", [n.notice_id]);
    } catch (err) {
      const msg = err instanceof Error ? err.name : "send failed"; // never the message itself
      await this.pool.query("SELECT huis.worker_finish_deletion_notice($1, 'failed', $2)", [n.notice_id, `${this.email.name}: ${msg}`.slice(0, 200)]);
    }
    return true;
  }

  /** Deletes one firm that is due, then its files. Returns true if it did anything. */
  async deleteOnce(): Promise<boolean> {
    const next = (await this.pool.query<{ id: string | null }>("SELECT huis.worker_next_firm_to_delete() AS id")).rows[0]?.id;
    if (next) {
      // The database checks again, under a lock, that it is still due; NULL means it isn't (it paid a moment ago).
      await this.pool.query("SELECT huis.worker_delete_firm($1)", [next]);
      return true;
    }
    // Files go after the rows (the firm is already gone and nothing can open them); retried until done.
    const pending = (await this.pool.query<{ firm_id: string; prefix: string }>("SELECT * FROM huis.worker_firm_files_pending()")).rows[0];
    if (!pending) return false;
    await this.files.deleteFirmPrefix(pending.prefix);
    await this.pool.query("SELECT huis.worker_firm_files_deleted($1)", [pending.firm_id]);
    return true;
  }

  /** One pass for the worker loop. Does nothing at all unless turned on. */
  async runOnce(): Promise<boolean> {
    if (!this.enabled) return false;
    const queued = await this.queueDue();
    return (await this.sendOnce()) || (await this.deleteOnce()) || queued > 0;
  }
}

/**
 * Email through Resend (https://resend.com/docs/api-reference/emails/send-email), when RESEND_API_KEY and
 * HUIS_MAIL_FROM are set. Which service Huis sends email with is still Tracy's decision (with production hosting);
 * this is the one the website's sign-up form already uses.
 */
export class ResendEmailSender implements EmailSender {
  readonly name = "Resend";
  constructor(private readonly apiKey: string, private readonly from: string, private readonly fetchImpl: typeof fetch = fetch) {}
  async send(m: EmailMessage): Promise<void> {
    const r = await this.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [m.to], subject: m.subject, text: m.text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) {
      const e = new Error(`HTTP ${r.status}`);
      e.name = `HTTP${r.status}`;
      throw e;
    }
  }
}

export function emailSenderFromEnv(env: NodeJS.ProcessEnv = process.env): EmailSender | null {
  return env.RESEND_API_KEY && env.HUIS_MAIL_FROM ? new ResendEmailSender(env.RESEND_API_KEY, env.HUIS_MAIL_FROM) : null;
}
