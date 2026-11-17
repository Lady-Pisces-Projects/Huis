import Link from "next/link";
import { TRIAL_TERMS, TRIAL_TERMS_TITLE, TRIAL_TERMS_VERSION } from "../../src/billing/trialTerms";

export const metadata = { title: "Free trial terms — Huis Law" };

/* Public: the free trial's non-payment and deletion terms (linked from sign-up, the website and warning emails). */
export default function TrialTermsPage() {
  return (
    <main className="centered">
      <div className="panel" style={{ maxWidth: 720 }}>
        <h1>{TRIAL_TERMS_TITLE}</h1>
        {TRIAL_TERMS.map((p) => <p key={p}>{p}</p>)}
        <p className="muted">Version {TRIAL_TERMS_VERSION}.</p>
        <p><Link href="/signup">Start your 7-day free trial</Link> · <Link href="/signin">Sign in</Link></p>
      </div>
    </main>
  );
}
