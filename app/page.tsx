import { redirect } from "next/navigation";
import "@fontsource/libre-caslon-text/400.css";
import "@fontsource/libre-caslon-text/400-italic.css";
import "@fontsource/inter/400.css";
import "@fontsource/inter/600.css";
import "./home.css";
import { getSession } from "../lib/server";

export const dynamic = "force-dynamic";

/*
 * The public homepage (self-serve funnel, decided 10 November 2026): explainer video → 7-day free trial → monthly
 * or yearly subscription. No demo requests: the video is the demo. Copy follows
 * docs/marketing/brand-and-direction-guide.md and the 4 November landing-page draft; every product claim here
 * must match what Huis does (docs/PHASE-*.md). Prices and trial limits match db/migrations/0032–0035.
 * Signed-in people go straight to their dashboard.
 */

const TRIAL_URL = "/signin";

function Logo({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={Math.round(size * 0.75)} viewBox="0 0 64 48" aria-hidden="true">
      <rect x="4" y="1" width="22" height="3" fill="#D9B66F" /><rect x="8" y="5" width="14" height="38" fill="#D9B66F" />
      <rect x="4" y="44" width="22" height="3" fill="#D9B66F" /><path d="M12 9v30M15 9v30M18 9v30" stroke="#0D1D29" strokeWidth="1.2" />
      <rect x="38" y="1" width="22" height="3" fill="#D9B66F" /><rect x="42" y="5" width="14" height="38" fill="#D9B66F" />
      <rect x="38" y="44" width="22" height="3" fill="#D9B66F" /><path d="M46 9v30M49 9v30M52 9v30" stroke="#0D1D29" strokeWidth="1.2" />
      <rect x="22" y="21" width="20" height="5" fill="#D9B66F" />
    </svg>
  );
}

/** Simple stroke icons (24×24), gold on navy tiles. */
const ICONS: Record<string, string> = {
  folder: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  link: "M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1",
  clock: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z",
  split: "M12 3v18M5 8l-2 4 2 4M19 8l2 4-2 4M3 12h6M15 12h6",
  search: "M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14zM21 21l-5-5",
  scale: "M12 3v18M7 21h10M5 7h14M5 7l-3 6a3 3 0 0 0 6 0zM19 7l-3 6a3 3 0 0 0 6 0z",
  chat: "M21 12a8 8 0 0 1-11.8 7L3 21l2-5.2A8 8 0 1 1 21 12z",
  people: "M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM22 19v-1a4 4 0 0 0-3-3.9M16 4.1a3 3 0 0 1 0 5.8",
  shield: "M12 3l8 3v6c0 4.5-3.4 8.2-8 9-4.6-.8-8-4.5-8-9V6z",
  lock: "M6 11h12v10H6zM8 11V8a4 4 0 0 1 8 0v3",
  fingerprint: "M12 11v3M8.5 8.5A5 5 0 0 1 17 12v2M7 12v1a8 8 0 0 0 2 5M12 3a9 9 0 0 1 9 9v1M3 13v-1a9 9 0 0 1 3-6.7",
  layers: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5",
  door: "M7 21V4a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v17M4 21h16M14 12h.01",
  log: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  export: "M12 3v12M7 10l5 5 5-5M5 21h14",
  pen: "M4 20h4L19 9l-4-4L4 16zM14 6l4 4",
};
function Icon({ name, color = "#D9B66F" }: { name: string; color?: string }) {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICONS[name]} />
    </svg>
  );
}
function Tick({ color = "#806338" }: { color?: string }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12l5 5 9-10" />
    </svg>
  );
}

const FEATURES: { icon: string; title: string; body: string }[] = [
  { icon: "pen", title: "Start with a description of the case", body: "Write a few lines about the case when you open the Matter. Huis suggests the people, organizations, key dates and possible claims for you to confirm." },
  { icon: "folder", title: "Organize case evidence", body: "Upload anything, from a single PDF to a full discovery set. Huis reads it, makes it searchable and files it in the Matter." },
  { icon: "link", title: "Connect communications to the right Matter", body: "Huis suggests where each email belongs. Your team decides, or lets Huis file automatically." },
  { icon: "clock", title: "Build intelligent timelines", body: "Dates, meetings and events pulled into one chronology, each linked to the document it came from." },
  { icon: "split", title: "Flag potential contradictions", body: "Statements set against the emails, texts and records, ready for attorney review." },
  { icon: "scale", title: "Map evidence to claims and elements", body: "See which elements are supported, which are thin and what to gather next." },
  { icon: "chat", title: "Ask the Matter in plain English", body: "Matter Brain answers from the Matter's own documents and shows the passages behind every answer." },
  { icon: "people", title: "Profiles for everyone in the case", body: "Witnesses, experts, opposing counsel, judges and contacts, reusable across Matters." },
  { icon: "fingerprint", title: "Preserve every original", body: "Originals are never altered. Your team annotates, redacts and exhibit-marks working copies." },
];

const SECURITY: { icon: string; title: string; body: string }[] = [
  { icon: "shield", title: "Your firm's data is walled off", body: "Each firm is isolated in the database itself, and its evidence is encrypted with its own keys." },
  { icon: "door", title: "Ethical walls and Matter-level access", body: "Permissions by role and by Matter. Walled Matters are visible only to the people you add, administrators included." },
  { icon: "fingerprint", title: "Chain of custody", body: "Every file is fingerprinted on arrival and scanned before anyone opens it. Originals never change." },
  { icon: "lock", title: "A secure client portal", body: "Clients upload their information safely. They never see privileged material, internal notes or AI analysis." },
  { icon: "log", title: "Tamper-evident audit trail", body: "Every view, download and change is recorded in a log built so that any alteration shows." },
  { icon: "layers", title: "No training on your data", body: "Huis doesn't use your firm's files to train AI models. Your firm owns its data and can export complete Matters at any time." },
];

export default async function Home() {
  if (await getSession()) redirect("/dashboard");
  return (
    <div className="hl">
      <a className="hl-skip" href="#main">Skip to content</a>
      <div className="hl-top">
        <header className="hl-wrap hl-head">
          <a className="hl-brand" href="/" aria-label="Huis Law home"><Logo /><span>HUIS LAW</span></a>
          <nav className="hl-nav" aria-label="Main">
            <a href="#how">How it works</a>
            <a href="#matter-brain">Matter Brain™</a>
            <a href="#security">Security</a>
            <a href="#pricing">Pricing</a>
            <a href="/signin">Sign in</a>
          </nav>
          <a className="hl-btn hl-btn-gold" href={TRIAL_URL}>Start Free Trial</a>
        </header>
      </div>

      <main id="main">
        <section className="hl-hero">
          <div className="hl-wrap">
            <p className="hl-eyebrow">Connected case intelligence.</p>
            <h1>Your Case Has a Story. <em>Huis Helps You See It.</em></h1>
            <p className="hl-lede">Organize the evidence. Connect the facts. Find the gaps. Build the strategy. Huis Law transforms scattered case information into organized legal intelligence.</p>
            <div className="hl-cta-row">
              <a className="hl-btn hl-btn-gold" href={TRIAL_URL}>Start Your 7-Day Free Trial</a>
              <a className="hl-btn hl-btn-ghost" href="#video">Watch Huis Organize a Case</a>
            </div>
            <p className="hl-fine">No card needed. Built for attorneys in every practice area.</p>
          </div>
        </section>

        <section className="hl-video-sec" id="video" aria-label="Explainer video">
          <div className="hl-wrap">
            {/* TODO(explainer video): replace this placeholder with the video player when the explainer is ready. */}
            <div className="hl-video" role="img" aria-label="Explainer video placeholder">
              <div className="hl-play"><svg width="26" height="26" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" fill="#D9B66F" /></svg></div>
              <strong>See Huis organize a case</strong>
              <span>Explainer video coming soon</span>
            </div>
            <div className="hl-steps">
              {["Organize the evidence", "Connect the facts", "Build the timeline", "Find contradictions and gaps", "Build a stronger strategy"].map((s, i) => (
                <div className="hl-step" key={s}><small>STEP {i + 1}</small>{s}</div>
              ))}
            </div>
          </div>
        </section>

        <section className="hl-sec">
          <div className="hl-wrap hl-one">
            <div>
              <p className="hl-kicker">One Matter. One source of intelligence.</p>
              <h2>The problem isn&apos;t finding more information. It&apos;s seeing how it fits together.</h2>
              <p className="hl-sec-intro">The email is in Outlook, the exhibit is in Dropbox, the timeline is in someone&apos;s spreadsheet. Huis Law brings the pieces into one Matter, so the story of the case is in one place instead of five.</p>
            </div>
            <div>
              <div className="hl-chips">
                {["Emails", "Documents", "Exhibits", "Witness statements", "Photos", "Financial records", "Court notices", "Messages", "Notes", "Research"].map((c) => (
                  <span className="hl-chip" key={c}>{c}</span>
                ))}
              </div>
              <p className="hl-arrow" aria-hidden="true">→ <span>One Matter</span></p>
              <p className="hl-connect">Connects to Outlook, OneDrive and SharePoint, Dropbox and Google Drive. Gmail is coming soon.</p>
            </div>
          </div>
        </section>

        <section className="hl-sec hl-sec-alt" id="features">
          <div className="hl-wrap">
            <p className="hl-kicker">What Huis Law does</p>
            <h2>AI that does the sorting. Attorneys who make the calls.</h2>
            <div className="hl-grid">
              {FEATURES.map((f) => (
                <article className="hl-card" key={f.title}>
                  <div className="hl-icon"><Icon name={f.icon} /></div>
                  <h3>{f.title}</h3>
                  <p>{f.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="hl-sec" id="how">
          <div className="hl-wrap">
            <p className="hl-kicker">Your 7-day free trial</p>
            <h2>See Huis work on a real case this week.</h2>
            <ol className="hl-trial hl-trial-list">
              <li><h3>Create your firm</h3><p>Sign in with your Microsoft work account. No card, no sales call.</p></li>
              <li><h3>Describe your case</h3><p>Open your first Matter and write what it&apos;s about. Huis suggests the people, dates and claims to confirm.</p></li>
              <li><h3>Bring in the evidence</h3><p>Connect Outlook or your file storage, or upload files. Huis reads and organizes them.</p></li>
              <li><h3>Ask the Matter</h3><p>Ask Matter Brain what happened, who said what and what&apos;s missing. Then choose monthly or yearly.</p></li>
            </ol>
          </div>
        </section>

        <section className="hl-sec hl-brain" id="matter-brain">
          <div className="hl-wrap hl-brain-grid">
            <div>
              <p className="hl-kicker">Introducing the Huis Matter Brain™</p>
              <h2>The intelligence layer for every case.</h2>
              <p className="hl-sec-intro">Instead of searching five different systems, your team asks the Matter. Huis searches it, connects the information and shows its work.</p>
              <p className="hl-brain-note"><strong>Every answer shows its sources:</strong> the passages in the emails, documents and notes it came from, so your team can check it before relying on it.</p>
            </div>
            <div className="hl-qs">
              {["What evidence supports this claim?", "Where does this witness contradict their earlier statement?", "What happened between March 12 and April 4?",
                "Which elements of this claim still lack supporting evidence?", "Show me every communication involving this person."].map((q) => (
                <p className="hl-q" key={q}>{q}</p>
              ))}
            </div>
          </div>
        </section>

        <section className="hl-sec" id="security">
          <div className="hl-wrap">
            <p className="hl-kicker">Built for legal work</p>
            <h2>Privilege and security are built in, not bolted on.</h2>
            <p className="hl-sec-intro">Attorney-client privilege comes first in every decision Huis makes. Each protection below is enforced by the system itself, and reviewed by independent security testing before every release.</p>
            <div className="hl-sec-grid">
              {SECURITY.map((x) => (
                <div className="hl-sec-item" key={x.title}>
                  <div className="hl-icon"><Icon name={x.icon} /></div>
                  <h3>{x.title}</h3>
                  <p>{x.body}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="hl-sec hl-sec-alt" id="pricing">
          <div className="hl-wrap">
            <p className="hl-kicker">Pricing</p>
            <h2>Simple pricing per attorney and staff member.</h2>
            <div className="hl-prices">
              <div className="hl-price">
                <h3>Free trial</h3>
                <p className="hl-amount">$0<small>for 7 days</small></p>
                <p className="hl-price-sub">No card needed.</p>
                <ul className="hl-ticks">
                  <li><Tick />1 seat and 1 Matter</li>
                  <li><Tick />2 GB of evidence</li>
                  <li><Tick />100 Matter Brain and agent questions</li>
                  <li><Tick />Everything Huis does automatically, unlimited</li>
                </ul>
                <a className="hl-btn hl-btn-navy" href={TRIAL_URL}>Start Your Free Trial</a>
              </div>
              <div className="hl-price hl-price-feature">
                <h3>Monthly</h3>
                <p className="hl-amount">$237<small>per seat / month</small></p>
                <p className="hl-price-sub">Cancel anytime.</p>
                <ul className="hl-ticks">
                  <li><Tick color="#D9B66F" />Unlimited Matters</li>
                  <li><Tick color="#D9B66F" />No storage or AI question limits</li>
                  <li><Tick color="#D9B66F" />Clients, co-counsel and experts free</li>
                  <li><Tick color="#D9B66F" />Seats billed only for active attorneys and staff</li>
                </ul>
                <a className="hl-btn hl-btn-gold" href={TRIAL_URL}>Start Free Trial</a>
              </div>
              <div className="hl-price">
                <span className="hl-badge">Two months free</span>
                <h3>Yearly</h3>
                <p className="hl-amount">$2,370<small>per seat / year</small></p>
                <p className="hl-price-sub">The same as 10 months of Monthly.</p>
                <ul className="hl-ticks">
                  <li><Tick />Everything in Monthly</li>
                  <li><Tick />Founding-member pricing for Early Access firms</li>
                  <li><Tick />Priority onboarding</li>
                </ul>
                <a className="hl-btn hl-btn-navy" href={TRIAL_URL}>Start Free Trial</a>
              </div>
            </div>
            <p className="hl-price-note">Every plan starts with the free trial; choose Monthly or Yearly from inside Huis when you&apos;re ready. Pay securely by card through Stripe; Huis never sees your card number. Enterprise pricing is available for larger firms.
              Once your firm has made its first payment, Huis never deletes its cases for non-payment.</p>
          </div>
        </section>

        <section className="hl-sec">
          <div className="hl-wrap hl-early">
            <div>
              <p className="hl-kicker">Early Access Program</p>
              <h2>Join the firms shaping Huis Law.</h2>
              <p className="hl-sec-intro">Start your free trial now. Founding-member codes are entered when you choose the yearly plan.</p>
              <div className="hl-cta-row"><a className="hl-btn hl-btn-navy" href={TRIAL_URL}>Start Your 7-Day Free Trial</a></div>
            </div>
            <ul>
              {["Founding-member pricing", "Priority onboarding", "Direct input into product development", "Early access to new intelligence features", "Matter Brain™ setup assistance"].map((x) => (
                <li key={x}><Tick />{x}</li>
              ))}
            </ul>
          </div>
        </section>

        <section className="hl-close">
          <div className="hl-wrap">
            <h2>Your case has a story. Huis helps you see it.</h2>
            <p>Turn scattered evidence into a clear, connected case strategy.</p>
            <div className="hl-cta-row" style={{ marginTop: 32 }}>
              <a className="hl-btn hl-btn-gold" href={TRIAL_URL}>Start Your 7-Day Free Trial</a>
            </div>
          </div>
        </section>
      </main>

      <footer className="hl-foot">
        <div className="hl-wrap hl-foot-row">
          <a className="hl-brand" href="/" aria-label="Huis Law home"><Logo size={32} /><span>HUIS LAW</span></a>
          {/* TODO(launch): add Privacy Policy and Terms of Service links once those pages exist. */}
          <p>Huis Law is software for legal professionals and does not provide legal advice. AI output is decision support for attorney review. © 2026 Huis Law.</p>
        </div>
      </footer>
    </div>
  );
}
