import { db } from "../../../lib/server";
import { authConfig } from "../../../src/auth/config";
import { ROLE_LABELS } from "../../../lib/ui";
import { previewInvitation } from "../../../src/services/firms";
import { GoogleMark, MicrosoftMark } from "../../signin/panel";

export const dynamic = "force-dynamic";

/*
 * Accepting an invitation is a button press on this page, which names the firm first (security review 29):
 * a link alone can't join someone's account to a firm.
 */
export default async function Invite({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const invitation = await previewInvitation(db(), token);
  const cfg = authConfig();
  return (
    <main className="centered">
      <div className="panel">
        {invitation ? (
          <>
            <h1>Join {invitation.firmName} on Huis Law</h1>
            <p className="sub">
              {invitation.firmName} has invited {invitation.inviteeName} as {(ROLE_LABELS[invitation.role] ?? invitation.role).toLowerCase()}.
              Sign in with the Microsoft or Google account you want to use for this firm. This invitation works once.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {cfg.microsoft ? (
                <form method="post" action="/api/auth/microsoft/start">
                  <input type="hidden" name="invite" value={token} />
                  <button type="submit" className="button ms-button" style={{ width: "100%" }}><MicrosoftMark />Accept and sign in with Microsoft</button>
                </form>
              ) : null}
              {cfg.google ? (
                <form method="post" action="/api/auth/google/start">
                  <input type="hidden" name="invite" value={token} />
                  <button type="submit" className="button ms-button" style={{ width: "100%" }}><GoogleMark />Accept and sign in with Google</button>
                </form>
              ) : null}
            </div>
            {!cfg.microsoft && !cfg.google ? <div className="flash error">Sign-in is not configured on this server yet.</div> : null}
            <p className="notice" style={{ marginTop: 16 }}>Don&apos;t recognise {invitation.firmName}? Close this page; nothing happens until you accept.</p>
          </>
        ) : (
          <>
            <h1>Invitation</h1>
            <div className="flash error">This invitation link is invalid, already used or expired. Ask your firm administrator for a new one.</div>
          </>
        )}
      </div>
    </main>
  );
}
