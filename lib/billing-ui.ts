import type { InvoiceSummary } from "../src/services/billing";
import { formatDollars } from "../src/services/subscription";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** A calendar date as written (YYYY-MM-DD), never shifted by time zones. */
export const showDay = (d: string) => { const [y, m, day] = d.split("-").map(Number) as [number, number, number]; return `${MONTHS[m - 1]} ${day}, ${y}`; };
export const STATUS_LABELS: Record<InvoiceSummary["status"], string> = { draft: "Draft", issued: "Issued", paid: "Paid", void: "Void" };
export const money = (c: number | null) => (c === null ? "—" : formatDollars(c));
