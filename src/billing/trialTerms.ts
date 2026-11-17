/*
 * The free trial's non-payment and data-deletion terms, in one place: shown and accepted before a firm is created,
 * on the public /trial-terms page, on the Subscription page and dashboard, and summarised in every deletion warning.
 *
 * The facts match the deletion rules in db/migrations/0041_trial_deletion.sql and 0042_review32.sql: deletion no
 * sooner than 30 days after the trial ends, after warnings to the firm's owners 14, 7 and 1 days before, and never for
 * a firm that has made its first payment. Wording to be reviewed by an attorney before launch (tracked as O-12).
 */

/** Bump when the wording changes in substance; the accepted version is recorded with the firm. */
export const TRIAL_TERMS_VERSION = "2026-11-17";

export const TRIAL_TERMS_TITLE = "Free trial terms: non-payment and data deletion";

export const TRIAL_TERMS: string[] = [
  "Your firm's 7-day free trial of Huis Law is provided at no charge and without any obligation to subscribe.",
  "If the firm has not made its first payment by the end of the trial, adding new work is suspended and the firm's account is scheduled for deletion. For at least 30 days after the trial ends, everyone at the firm can still sign in, view and export every Matter. Huis Law will email the firm's owners 14 days, 7 days and 1 day before the deletion date.",
  "On the deletion date, Huis Law will permanently delete the firm's account and all of its data, including Matters, documents, emails, notes, people and billing records. Huis Law will not recover or restore deleted data. Huis Law keeps only a minimal record that the account was deleted (its identifier, the relevant dates and the warnings sent). Deleted data is not restored from any backup.",
  "The firm is solely responsible for exporting and keeping any information it needs before the deletion date, including any records it must retain under the rules of professional conduct, court rules, a litigation hold or other law. To the fullest extent permitted by law, Huis Law is not responsible or liable for any loss, claim or damage arising from the deletion of a trial firm's data in accordance with these terms.",
  "Firms that have made their first payment are never deleted for non-payment. If a paid subscription later stops, the firm's data is kept and remains available to view and export.",
];

/** One line for places with little room. */
export const TRIAL_TERMS_SHORT =
  "If your firm doesn't subscribe by the end of the free trial, its account and all of its data will be permanently deleted no sooner than 30 days later, after email warnings. Export anything you need to keep before then.";

/** The paragraph added to every deletion warning email. */
export const TRIAL_TERMS_EMAIL =
  "As set out in the free trial terms the firm accepted when it signed up, the firm is solely responsible for exporting any information it needs, including records it must retain under the rules of professional conduct, court rules or a litigation hold. Huis Law will not recover deleted data and is not responsible for any loss arising from the deletion of trial data in accordance with those terms.";
