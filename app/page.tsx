import { redirect } from "next/navigation";
import { getSession } from "../lib/server";

export const dynamic = "force-dynamic";

/*
 * The app (app.huislaw.ai) has no homepage of its own. The public website is the static huislaw.ai site in
 * website/ (decided by Tracy on 12 November 2026); its "Start Your 7-Day Free Trial" buttons will point to /signup.
 */
export default async function Home() {
  redirect((await getSession()) ? "/dashboard" : "/signin");
}
