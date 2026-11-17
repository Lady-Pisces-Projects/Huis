# huislaw.ai — marketing homepage

The public website for Huis Law (decided by Tracy on 12 November 2026: this static site is the homepage; the app
lives at **app.huislaw.ai** and has no homepage of its own). Brand palette: Midnight Navy #0D1D29, Champagne Gold
#D9B66F, Warm Ivory #F7F3EB, Slate Blue #738C9B, Antique Bronze #806338.

No build step and nothing stored on the site. The one function emails trial sign-ups to the Huis team via Resend.

```
index.html        the homepage (all CSS and JS inline)
favicon.ico       gold pillar "H" from the Huis Law logo (16, 32, 48 px)
icon-192.png      the same mark for browsers and phones
apple-touch-icon.png  home-screen icon (iPhone, iPad)
api/waitlist.js   trial sign-up form -> email to the Huis team (Resend)
vercel.json       security headers (HSTS, CSP, no framing)
```

## Deploy on Vercel
1. vercel.com → sign in with GitHub → **Add New… → Project** → import `tracypeart/Huis`.
2. **Root Directory**: `website`. Framework preset: **Other**. No build command.
3. **Settings → Environment Variables** (Production):
   - `RESEND_API_KEY`: from resend.com → API Keys (sending access only)
   - `WAITLIST_TO`: where sign-ups go, e.g. `hello@huislaw.ai`
   - `WAITLIST_FROM`: e.g. `Huis Law <signups@huislaw.ai>` (verify huislaw.ai in Resend → Domains; add the DNS records it gives you in GoDaddy)
4. Deploy, then redeploy once after adding the variables.

## Connect huislaw.ai (GoDaddy)
In Vercel: **Project → Settings → Domains** → add `huislaw.ai` and `www.huislaw.ai` (redirect www → huislaw.ai).
In GoDaddy: **My Products → huislaw.ai → DNS → Manage DNS**:

| Type  | Name | Value                | TTL    |
|-------|------|----------------------|--------|
| A     | @    | 76.76.21.21          | 1 hour |
| CNAME | www  | cname.vercel-dns.com | 1 hour |

- Delete any existing **A @** record pointing to GoDaddy "Parked" or website builder, and turn off GoDaddy **Domain Forwarding** if set.
- If Vercel's Domains screen shows different values, use Vercel's.
- Don't touch MX records (email). HTTPS is issued automatically once DNS resolves.

## Before launch
- [ ] `hello@huislaw.ai` mailbox exists (used for "Contact us" and the footer)
- [ ] Submit the form on the live site and confirm the email arrives
- [ ] Security claims and AI disclaimer reviewed by the Utah attorney advisor (O-5)
- [ ] Privacy Policy and Terms pages (include: only trials that end before a first payment are deleted, after 30 days read-only)
- [ ] When the explainer video is ready, add `huis-explainer.mp4` and `video-poster.jpg` here and swap the mock in `index.html` (see the HTML comment)
- [ ] When Google approves Gmail access for outside firms, change "Gmail coming soon" back to "Outlook and Gmail" (three places)

## When the app goes live
Point every "Start Your 7-Day Free Trial" button to `https://app.huislaw.ai/signup` instead of the `#trial` form.
The app's `/signup` page lets attorneys start a trial with Microsoft or Google.
