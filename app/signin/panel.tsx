import Link from "next/link";
import { getSession } from "../../lib/server";
import { authConfig } from "../../src/auth/config";

const REASONS: Record<string, string> = {
  cancelled: "Sign-in was cancelled.",
  invalid: "That sign-in attempt expired or was invalid. Please try again.",
  failed: "We couldn't complete sign-in. Please try again.",
  "failed-microsoft": "We couldn't complete sign-in with Microsoft. Please try again.",
  "failed-google": "We couldn't complete sign-in with Google. Please try again.",
  expired: "Your session ended. Please sign in again.",
  invite: "That invitation link is invalid, already used or expired. Ask your firm administrator for a new one.",
  signedout: "You have signed out.",
  org: "Your firm requires signing in with the firm's own Microsoft 365 or Google Workspace account. Sign in with that account, or ask your firm administrator.",
  "invite-org": "This firm requires its staff to sign in with the firm's own Microsoft 365 or Google Workspace account. Open the invitation again and sign in with that account.",
};

export function MicrosoftMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 21 21" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#f25022" /><rect x="11" y="1" width="9" height="9" fill="#7fba00" />
      <rect x="1" y="11" width="9" height="9" fill="#00a4ef" /><rect x="11" y="11" width="9" height="9" fill="#ffb900" />
    </svg>
  );
}
export function GoogleMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.4 5.7c4.3-4 6.9-9.9 6.9-17.1z" />
      <path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z" />
      <path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.4-5.7c-2.1 1.4-4.8 2.3-8.5 2.3-6.2 0-11.5-4.1-13.4-9.9l-7.9 6.1C6.6 42.6 14.6 48 24 48z" />
    </svg>
  );
}

/** The sign-in panel, shared by /signin and /signup (the huislaw.ai website's "Start Your 7-Day Free Trial" buttons). */
export async function SignInPanel({ reason, mode }: { reason?: string; mode: "signin" | "signup" }) {
  const cfg = authConfig();
  const microsoftReady = Boolean(cfg.microsoft);
  const googleReady = Boolean(cfg.google);
  // Already signed in: offer the way back (a link, not an automatic redirect, so an ended session can't loop).
  const signedIn = !reason && Boolean(await getSession());
  const verb = mode === "signup" ? "Continue" : "Sign in";
  return (
    <main className="centered">
      <div className="panel">
        <h1>{mode === "signup" ? "Start your 7-day free trial" : "Huis Law"}</h1>
        <p className="sub">{mode === "signup"
          ? <>No card needed. Sign in with your work account to create your firm; you&apos;ll name it on the next screen. A firm that doesn&apos;t subscribe is deleted after the trial, as set out in the <Link href="/trial-terms">free trial terms</Link>.</>
          : "Your case has a story. Huis helps you see it."}</p>
        {reason && REASONS[reason] ? <div className={`flash ${reason === "signedout" ? "success" : "error"}`}>{REASONS[reason]}</div> : null}
        {signedIn ? <div className="flash success">You&apos;re already signed in. <Link href="/dashboard">Go to your dashboard</Link></div> : null}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {microsoftReady ? <a className="button ms-button" href="/api/auth/microsoft/start"><MicrosoftMark />{verb} with Microsoft</a> : null}
          {googleReady ? <a className="button ms-button" href="/api/auth/google/start"><GoogleMark />{verb} with Google</a> : null}
        </div>
        {!microsoftReady && !googleReady ? <div className="flash error">Sign-in is not configured on this server yet.</div> : null}
        {mode === "signin"
          ? <p className="notice" style={{ marginTop: 16 }}>New to Huis? <Link href="/signup">Start your 7-day free trial</Link>.</p>
          : <p className="notice" style={{ marginTop: 16 }}>Already have an account? <Link href="/signin">Sign in</Link>. Joining your firm? Use the invitation link your administrator sent you.</p>}
        <p className="notice" style={{ marginTop: 24 }}>
          Huis Law stores attorney-client privileged information. Access is limited to authorized users and every
          action is recorded in your firm&apos;s audit log. Huis asks Microsoft or Google only for your name and email.
        </p>
      </div>
    </main>
  );
}
