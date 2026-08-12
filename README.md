# 🔧 SLO Handyman

A friendly, mobile-first **handyman marketplace** for San Luis Obispo.

- Customers browse local handymen, describe a job, and **pay securely online**.
- You (the owner) earn from **two revenue streams**:
  - a **$5 booking fee** the customer pays to hire, and
  - a **12% commission** taken from the handyman's job payment.
- Handymen get paid out automatically to their bank via **Stripe Connect**.

Both amounts and everything else are configurable in `.env`.

---

## How the money flows

Example: a customer hires a handyman for a **$200** job.

| Item | Amount |
| --- | --- |
| Job price | $200.00 |
| Booking fee (customer pays) | $5.00 |
| **Customer pays total** | **$205.00** |
| Your booking fee | $5.00 |
| Your 12% commission | $24.00 |
| **You earn** | **$29.00** |
| **Handyman receives** | **$176.00** |

Stripe splits this automatically in a single payment — you never manually hold anyone's money.

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Add your Stripe keys

Copy `.env.example` to `.env` and fill in your keys from
[dashboard.stripe.com/apikeys](https://dashboard.stripe.com/apikeys).
Use your **test** keys while building.

```bash
cp .env.example .env   # on Windows PowerShell: copy .env.example .env
```

You also need to **enable Stripe Connect** in your dashboard
(Connect → Get started → platform/marketplace).

### 3. Run it

```bash
npm start
```

Open http://localhost:3000

The site runs even without Stripe keys so you can preview the design —
hiring and payouts activate once keys are added.

---

## Pages

| Page | What it does |
| --- | --- |
| `/` | Home — browse available handymen |
| `/handyman.html?id=…` | Handyman profile + hire & pay form |
| `/join.html` | Become a handyman (Stripe Connect onboarding) |
| `/success.html` | Booking confirmation + your private booking link |
| `/job.html?id=…&token=…` | Customer's private booking page — release escrow payment, then review |
| `/pro.html?id=…&token=…` | Handyman's private dashboard — bookings, contact info, mark work done |
| `/admin.html` | Owner dashboard — earnings & jobs (uses `ADMIN_TOKEN`) |

---

## How customers and handymen connect

The two sides are linked through each job, and **money is held in escrow** until the
customer confirms the work is done.

1. **Handyman joins** → gets a **private dashboard link** (`/pro.html?id=…&token=…`). This token is their password — they bookmark it.
2. **Customer hires & pays.** They can book by **hours × the handyman's rate** (auto-calculated) or a **flat price**. Their card is charged the job price + your $5 booking fee.
3. **The money is HELD by the platform (escrow)** — it is *not* sent to the handyman yet. Contact info is exchanged both ways (revealed only after payment): the customer sees the handyman's phone/email on their booking page, and the handyman sees the customer's details in their dashboard.
4. **Handyman does the work**, then taps **"Mark work as done"** to nudge the customer.
5. **Customer releases payment.** On their private booking page (`/job.html?id=…&token=…`) they tap **"Job's done — release payment."** *Only then* is the handyman's payout transferred to their Stripe account. This guarantees the handyman isn't paid until the job is done, and protects the customer.
6. **Customer leaves a review** — a **1–5 star** rating + optional note (only after completion). Ratings show as an average on the handyman's profile/browse card, notes appear on their public profile, and the handyman sees each rating in their dashboard.
7. **You (owner)** see every job, status, rating, and your earnings in `/admin.html`.

### How escrow works technically

- Checkout uses Stripe **separate charges & transfers**: the charge goes to your platform
  balance (no `transfer_data`), so funds are held by you.
- When the customer releases payment, the server creates a **Transfer** to the handyman's
  connected account for their payout, using `source_transaction` (the original charge) so
  it works even before the balance settles. Your $5 booking fee + 12% commission stay with
  you automatically.

> Coordination + release are **in-app** (no emails/SMS yet). To auto-notify both sides
> (e.g. "payment released"), plug in SendGrid/Twilio in `server/index.js`.

### Pricing (hours × rate)

- The handyman's hourly rate drives an **estimated total** at booking (`rate × hours`).
- Prefer a fixed quote? The customer can toggle **flat-price** and enter a total.
- Handling jobs that run over/under the estimate (top-up charge or partial refund) is a
  natural **phase 2** — the escrow foundation is already in place for it.

---

## Testing payments (Stripe test mode)

1. Join as a handyman at `/join.html` and complete Stripe's test onboarding
   (use test data — Stripe provides prefilled values in test mode).
2. Go back to the home page, open that handyman, and book a job.
3. At Stripe Checkout use test card `4242 4242 4242 4242`, any future date, any CVC.
4. See the payment and your cut in `/admin.html`.

### Automatic "paid" tracking (optional but recommended)

Set up a webhook so jobs are marked paid instantly:

```bash
stripe listen --forward-to localhost:3000/webhook
```

Copy the `whsec_…` secret it prints into `STRIPE_WEBHOOK_SECRET` in `.env`.
(Without it, the success page still confirms payment as a fallback.)

---

## Going live

1. Switch `.env` to your **live** Stripe keys and set `BASE_URL` to your real domain.
2. Deploy to any Node host (Render, Railway, Fly.io, a VPS, etc.).
3. Add a live webhook endpoint in the Stripe dashboard pointing to
   `https://yourdomain.com/webhook`.

> ⚠️ **California note:** unlicensed handyman work is capped at **$1,000** per job
> (labor + materials). Larger jobs require a CSLB contractor license. Consider
> showing this on your site and adding Terms & a refund policy.

---

## Data

For simplicity this MVP stores data in `data/db.json`. When you grow, swap the
functions in `server/db.js` for a real database — nothing else needs to change.
