import { redirect } from "next/navigation";
import { createFirmAction } from "../../lib/actions";
import { getFlash, getPending, getSession } from "../../lib/server";
import { FlashBanner, StateSelect } from "../../lib/ui";
import { TRIAL_TERMS, TRIAL_TERMS_TITLE } from "../../src/billing/trialTerms";

export const dynamic = "force-dynamic";

export default async function Onboarding({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  const pending = await getPending();
  if (!pending) {
    // Already signed in to a firm: nothing to set up here.
    if (await getSession()) redirect("/dashboard");
    redirect("/signin?reason=invalid");
  }
  const flash = await getFlash((await searchParams).f);
  return (
    <main className="centered">
      <div className="panel" style={{ maxWidth: 560 }}>
        <h1>Set up your firm</h1>
        <p className="sub">
          Signed in as {pending.name}{pending.email ? ` (${pending.email})` : ""}. Your firm starts with a free 7-day trial.
          If you were invited to an existing firm, use the invitation link instead.
        </p>
        <FlashBanner flash={flash} />
        <form action={createFirmAction} className="stack">
          <label>Firm name<input name="firmName" required minLength={2} maxLength={200} placeholder="e.g. Smith & Rivera Law" /></label>
          <label>Your name (as it should appear on matters)<input name="ownerName" defaultValue={pending.name} required maxLength={200} /></label>
          <label>Main office name<input name="locationName" defaultValue="Main Office" maxLength={200} /></label>
          <label>State<StateSelect name="stateCode" /></label>
          <details>
            <summary><strong>{TRIAL_TERMS_TITLE}</strong></summary>
            {TRIAL_TERMS.map((p) => <p key={p}>{p}</p>)}
          </details>
          <label style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <input type="checkbox" name="acceptTrialTerms" value="yes" required style={{ width: "auto", marginTop: 4 }} />
            <span>I have read and accept the <a href="/trial-terms" target="_blank" rel="noopener">free trial terms</a>, including that the firm&apos;s account and data will be permanently deleted if it doesn&apos;t subscribe, and that the firm is responsible for exporting anything it needs before then.</span>
          </label>
          <button type="submit">Create firm</button>
        </form>
      </div>
    </main>
  );
}
