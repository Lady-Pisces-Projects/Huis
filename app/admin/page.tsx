import Link from "next/link";
import { requireStaff } from "../../lib/admin";
import { adminSignOutAction } from "../../lib/admin-actions";
import { date } from "../../lib/ui";
import { listFirms } from "../../src/services/admin";
import { standing, TONE } from "../../src/admin/standing";

export const dynamic = "force-dynamic";


/** Phase 10 part 6: every firm's account, for Huis staff. Account fields and counts only. */
export default async function AdminHome({ searchParams }: { searchParams: Promise<{ q?: string }> }) {
  const { q } = await searchParams;
  const { staff, platform } = await requireStaff();
  const firms = await listFirms(platform, q);
  const trials = firms.filter((f) => f.plan === "trial" && !f.writeBlock).length;
  const paying = firms.filter((f) => f.plan !== "trial" && !f.writeBlock && f.status === "active").length;
  return (
    <main style={{ maxWidth: 1180, margin: "0 auto", padding: "24px 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap" }}>
        <div><h1 style={{ margin: 0 }}>Huis admin portal</h1><p className="sub" style={{ margin: 0 }}>Signed in as {staff.name}. Firm accounts only.</p></div>
        <form action={adminSignOutAction}><button type="submit" className="secondary">Sign out</button></form>
      </div>
      <div className="grid" style={{ margin: "20px 0" }}>
        <div className="card"><div className="stat">{firms.length}</div><div className="stat-label">Firms{q ? " matching" : ""}</div></div>
        <div className="card"><div className="stat">{trials}</div><div className="stat-label">On a running trial</div></div>
        <div className="card"><div className="stat">{paying}</div><div className="stat-label">Paying</div></div>
      </div>
      <form method="get" style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <label htmlFor="q" className="sr-only">Search firms</label>
        <input id="q" name="q" defaultValue={q ?? ""} placeholder="Firm name, address or owner email" maxLength={200} style={{ flex: 1 }} />
        <button type="submit">Search</button>
      </form>
      <div className="card" style={{ overflowX: "auto", padding: 0 }}>
        <table>
          <thead><tr><th>Firm</th><th>Owner</th><th>Standing</th><th>Seats</th><th>Matters</th><th>Started</th></tr></thead>
          <tbody>
            {firms.map((f) => {
              const s = standing(f);
              return (
                <tr key={f.firmId}>
                  <td><Link href={`/admin/firms/${f.firmId}`}>{f.name}</Link><div className="notice">{f.slug} · {f.stateCode}</div></td>
                  <td>{f.ownerName ?? "—"}<div className="notice">{f.ownerEmail ?? ""}</div></td>
                  <td style={{ color: TONE[s.tone], fontWeight: 600 }}>{s.label}</td>
                  <td>{f.seatsUsed}{f.seatLimit !== null ? ` / ${f.seatLimit}` : ""}</td>
                  <td>{f.matters}</td>
                  <td>{date(f.createdAt)}</td>
                </tr>
              );
            })}
            {firms.length === 0 ? <tr><td colSpan={6} className="notice">No firms{q ? " match that search" : " yet"}.</td></tr> : null}
          </tbody>
        </table>
      </div>
      <p className="notice" style={{ marginTop: 12 }}>Showing up to 500 firms, newest first.</p>
    </main>
  );
}
