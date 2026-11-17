import { authConfig } from "../../../src/auth/config";
import { GoogleMark, MicrosoftMark } from "../../signin/panel";

export const dynamic = "force-dynamic";

const REASONS: Record<string, string> = {
  denied: "That account isn't on the Huis staff list.",
  signedout: "You have signed out of the admin portal.",
};

/** Huis staff only. Signing in here never opens or creates a firm. */
export default async function AdminSignIn({ searchParams }: { searchParams: Promise<{ reason?: string }> }) {
  const { reason } = await searchParams;
  const cfg = authConfig();
  return (
    <main className="centered">
      <div className="panel">
        <h1>Huis admin portal</h1>
        <p className="sub">For Huis staff. Firm accounts only: no Matter, document or client information is shown here.</p>
        {reason && REASONS[reason] ? <div className={`flash ${reason === "signedout" ? "success" : "error"}`}>{REASONS[reason]}</div> : null}
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {cfg.microsoft ? <a className="button ms-button" href="/api/auth/microsoft/start?purpose=admin"><MicrosoftMark />Staff sign-in with Microsoft</a> : null}
          {cfg.google ? <a className="button ms-button" href="/api/auth/google/start?purpose=admin"><GoogleMark />Staff sign-in with Google</a> : null}
        </div>
      </div>
    </main>
  );
}
