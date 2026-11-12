import type { AdminFirm } from "../services/admin";

const fmt = (d: Date) => d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "America/Denver" });

/** A firm's standing in one phrase, for the admin portal. */
export function standing(f: AdminFirm): { label: string; tone: "ok" | "warn" | "bad" } {
  if (f.status !== "active") return { label: "Suspended", tone: "bad" };
  if (f.deleteAfter) return { label: `Trial ended, deletes ${fmt(f.deleteAfter)}`, tone: "bad" };
  if (f.writeBlock) return { label: f.plan === "trial" ? "Trial ended" : "Paused (unpaid or ended)", tone: "warn" };
  if (f.plan === "trial") return { label: f.stripeStatus === "trialing" ? "Trial, subscribed" : "Trial", tone: "ok" };
  return { label: f.stripeStatus ? `Paying (Stripe, ${f.billingInterval === "year" ? "yearly" : "monthly"})` : `Paying (${f.plan}, by agreement)`, tone: "ok" };
}

export const TONE = { ok: "#1f6f43", warn: "#8a5a00", bad: "#b42318" } as const;
