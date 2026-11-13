// Vercel serverless function: receives the trial sign-up form and emails it
// to the Huis team via Resend. Nothing is stored on the website.
//
// Environment variables (set in Vercel > Project > Settings > Environment Variables):
//   RESEND_API_KEY  - Resend API key (never commit it)
//   WAITLIST_TO     - inbox that receives sign-ups, e.g. hello@huislaw.ai
//   WAITLIST_FROM   - verified sender, e.g. "Huis Law <signups@huislaw.ai>"

const MAX = { name: 120, firm: 160, email: 200, practice: 60, attorneys: 20 };
const PRACTICES = ['Personal Injury', 'Family Law', 'Criminal Defense', 'Employment Law', 'General Litigation', 'Other'];
const SIZES = ['1', '2–5', '6–20', '21–50', '50+'];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
  body = body || {};

  // Honeypot: bots fill the hidden "website" field. Pretend success.
  if (body.website) return res.status(200).json({ ok: true });

  const d = {};
  for (const k of Object.keys(MAX)) {
    const v = typeof body[k] === 'string' ? body[k].trim() : '';
    if (!v || v.length > MAX[k]) return res.status(400).json({ error: `Invalid ${k}` });
    d[k] = v;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) return res.status(400).json({ error: 'Invalid email' });
  if (!PRACTICES.includes(d.practice) || !SIZES.includes(d.attorneys)) return res.status(400).json({ error: 'Invalid selection' });

  const { RESEND_API_KEY, WAITLIST_TO, WAITLIST_FROM } = process.env;
  if (!RESEND_API_KEY || !WAITLIST_TO || !WAITLIST_FROM) {
    console.error('waitlist: missing environment variables');
    return res.status(500).json({ error: 'Not configured' });
  }

  const html = `<h2>New Huis Law trial sign-up</h2>
<p><b>Name:</b> ${esc(d.name)}<br><b>Firm:</b> ${esc(d.firm)}<br><b>Email:</b> ${esc(d.email)}<br>
<b>Practice area:</b> ${esc(d.practice)}<br><b>Attorneys:</b> ${esc(d.attorneys)}</p>`;

  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: WAITLIST_FROM,
        to: [WAITLIST_TO],
        reply_to: d.email,
        subject: `Trial sign-up: ${d.firm} (${d.attorneys} attorneys)`,
        html,
      }),
    });
    if (!r.ok) {
      console.error('waitlist: resend error', r.status);
      return res.status(502).json({ error: 'Could not send' });
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('waitlist: request failed');
    return res.status(502).json({ error: 'Could not send' });
  }
};
