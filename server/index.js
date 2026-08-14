import "dotenv/config";
import express from "express";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import Stripe from "stripe";
import * as db from "./db.js";
import * as auth from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "public");
// On Render, store uploads on the persistent disk; locally, use public/uploads.
const UPLOADS_DIR = process.env.RENDER ? "/data/uploads" : path.join(PUBLIC_DIR, "uploads");
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const PORT = process.env.PORT || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const BOOKING_FEE = Number(process.env.BOOKING_FEE || 5);
const COMMISSION_PERCENT = Number(process.env.COMMISSION_PERCENT || 5);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "change-me-to-a-secret";

// Social sign-in client IDs (optional). Buttons only appear when these are set.
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const APPLE_CLIENT_ID = process.env.APPLE_CLIENT_ID || "";
const COOKIE_SECURE = BASE_URL.startsWith("https://");

const BOOKING_FEE_CENTS = Math.round(BOOKING_FEE * 100);

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

// --- Email -----------------------------------------------------------------
// Two ways to send, tried in this order:
//   1. Resend  (recommended)  — set RESEND_API_KEY (+ a verified MAIL_FROM domain)
//   2. SMTP    (fallback)     — set SMTP_HOST / SMTP_PORT / SMTP_USER / SMTP_PASS
// If neither is set, mail is skipped (the app keeps working; it just logs).
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";

const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const CONTACT_EMAIL = process.env.CONTACT_EMAIL || "slohandyman@smart-folder.com";

// Friendly "from" for all outgoing mail. For Resend this MUST be an address on
// a domain you've verified in Resend (e.g. "SLO Handyman <notifications@slohandyman.com>").
const MAIL_FROM =
  process.env.MAIL_FROM ||
  (SMTP_USER ? `"SLO Handyman" <${SMTP_USER}>` : "SLO Handyman <notifications@slohandyman.com>");

const smtpEnabled = !!(SMTP_HOST && SMTP_USER && SMTP_PASS);

// Send via Resend's REST API (no SDK dependency needed).
async function sendViaResend({ to, subject, text, html, replyTo }) {
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: MAIL_FROM,
      to: [to],
      subject,
      text,
      html,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Resend ${res.status}: ${detail}`);
  }
  return true;
}

// Lazily create a single reusable SMTP transporter (fallback path).
let _transporter = null;
async function getTransporter() {
  if (!smtpEnabled) return null;
  if (_transporter) return _transporter;
  const nodemailer = await import("nodemailer");
  _transporter = nodemailer.default.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  return _transporter;
}

async function sendViaSmtp({ to, subject, text, html, replyTo }) {
  const transporter = await getTransporter();
  if (!transporter) return false;
  await transporter.sendMail({ from: MAIL_FROM, to, subject, text, html, replyTo });
  return true;
}

// Best-effort send. Never throws, so webhooks/requests don't fail if mail does.
// Prefers Resend; falls back to SMTP if Resend isn't configured or errors.
async function sendEmail({ to, subject, text, html, replyTo }) {
  if (!to) return false;

  if (RESEND_API_KEY) {
    try {
      await sendViaResend({ to, subject, text, html, replyTo });
      return true;
    } catch (err) {
      console.error("Resend send failed:", err.message);
      // Fall through to SMTP if it's available.
    }
  }

  if (smtpEnabled) {
    try {
      return await sendViaSmtp({ to, subject, text, html, replyTo });
    } catch (err) {
      console.error("SMTP send failed:", err.message);
      return false;
    }
  }

  console.log(`[email skipped — no email provider configured] to=${to} subject="${subject}"`);
  return false;
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

// Emails the handyman that a new, already-paid booking is waiting. Kept
// privacy-light on purpose: no customer contact details — just the service,
// the amount, and a link to log in and accept or decline.
async function notifyHandymanNewBooking(job) {
  try {
    const handyman = db.getHandyman(job.handymanId);
    if (!handyman || !handyman.email) return;

    const dashboardUrl = `${BASE_URL}/pro.html?id=${handyman.id}&token=${handyman.manageToken}`;
    const service = job.service || "a handyman job";
    const payout = `$${(job.handymanPayoutCents / 100).toFixed(2)}`;
    const when = job.scheduledFor ? `Preferred date: ${job.scheduledFor}` : "";
    const subject = "New job request — action needed";

    const text = [
      `Hi ${handyman.name || "there"},`,
      "",
      `You have a new job request for "${service}". The customer has already paid and the money is held safely in escrow until you respond.`,
      when,
      `Your payout if you accept: ${payout}`,
      "",
      "Log in to your dashboard to accept or decline:",
      dashboardUrl,
      "",
      "Please respond soon so the customer isn't left waiting.",
      "",
      "— SLO Handyman",
    ].filter(Boolean).join("\n");

    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1a2233">
        <h2 style="margin:0 0 8px">New job request</h2>
        <p style="margin:0 0 14px">Hi ${escapeHtml(handyman.name || "there")}, you have a new booking waiting for you.</p>
        <table style="width:100%;border-collapse:collapse;margin:0 0 18px">
          <tr><td style="padding:6px 0;color:#6b7280">Service</td><td style="padding:6px 0;text-align:right;font-weight:700">${escapeHtml(service)}</td></tr>
          ${job.scheduledFor ? `<tr><td style="padding:6px 0;color:#6b7280">Preferred date</td><td style="padding:6px 0;text-align:right;font-weight:700">${escapeHtml(job.scheduledFor)}</td></tr>` : ""}
          <tr><td style="padding:6px 0;color:#6b7280">Your payout</td><td style="padding:6px 0;text-align:right;font-weight:700">${payout}</td></tr>
        </table>
        <p style="margin:0 0 16px;color:#374151">The customer has already paid and the money is held safely in escrow until you accept.</p>
        <p style="margin:0 0 22px">
          <a href="${dashboardUrl}" style="background:#f5871f;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px;display:inline-block">Accept or decline this job</a>
        </p>
        <p style="margin:0;color:#9ca3af;font-size:13px">Please respond soon so the customer isn't left waiting.<br>— SLO Handyman</p>
      </div>`;

    await sendEmail({ to: handyman.email, subject, text, html });
  } catch (err) {
    console.error("New-booking notification failed:", err.message);
  }
}

// Small helper so every email shares the same button look.
function emailButton(url, label) {
  return `<a href="${url}" style="background:#f5871f;color:#fff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:10px;display:inline-block">${escapeHtml(label)}</a>`;
}

function customerBookingUrl(job) {
  return `${BASE_URL}/job.html?id=${job.id}&token=${job.reviewToken}`;
}

// Customer: their handyman accepted the job (contact details now shared).
async function notifyCustomerAccepted(job) {
  try {
    if (!job.customerEmail) return;
    const handyman = db.getHandyman(job.handymanId);
    const name = job.handymanName || (handyman && handyman.name) || "Your handyman";
    const link = customerBookingUrl(job);
    const service = job.service || "your job";
    const subject = `${name} accepted your booking`;

    const contactLines = [];
    if (handyman && handyman.phone) contactLines.push(`Phone: ${handyman.phone}`);
    if (handyman && handyman.email) contactLines.push(`Email: ${handyman.email}`);

    const text = [
      `Hi ${job.customerName || "there"},`,
      "",
      `Good news — ${name} accepted your booking for "${service}". Your payment stays held safely until you release it after the work is done.`,
      contactLines.length ? "" : null,
      ...contactLines,
      "",
      "View your booking or release payment once you're happy with the work:",
      link,
      "",
      "— SLO Handyman",
    ].filter((l) => l !== null).join("\n");

    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1a2233">
        <h2 style="margin:0 0 8px">Your booking was accepted</h2>
        <p style="margin:0 0 14px">Hi ${escapeHtml(job.customerName || "there")}, ${escapeHtml(name)} accepted your booking for <strong>${escapeHtml(service)}</strong>.</p>
        ${(handyman && (handyman.phone || handyman.email)) ? `
        <table style="width:100%;border-collapse:collapse;margin:0 0 18px">
          ${handyman.phone ? `<tr><td style="padding:6px 0;color:#6b7280">Phone</td><td style="padding:6px 0;text-align:right;font-weight:700">${escapeHtml(handyman.phone)}</td></tr>` : ""}
          ${handyman.email ? `<tr><td style="padding:6px 0;color:#6b7280">Email</td><td style="padding:6px 0;text-align:right;font-weight:700">${escapeHtml(handyman.email)}</td></tr>` : ""}
        </table>` : ""}
        <p style="margin:0 0 16px;color:#374151">Your payment stays held safely in escrow until you release it after the work is done.</p>
        <p style="margin:0 0 22px">${emailButton(link, "View my booking")}</p>
        <p style="margin:0;color:#9ca3af;font-size:13px">— SLO Handyman</p>
      </div>`;

    await sendEmail({ to: job.customerEmail, subject, text, html });
  } catch (err) {
    console.error("Accept notification failed:", err.message);
  }
}

// Customer: the handyman declined and they were fully refunded.
async function notifyCustomerDeclined(job) {
  try {
    if (!job.customerEmail) return;
    const name = job.handymanName || "The handyman";
    const service = job.service || "your job";
    const refund = `$${(job.totalChargedCents / 100).toFixed(2)}`;
    const subject = "Your booking was declined — full refund on the way";

    const text = [
      `Hi ${job.customerName || "there"},`,
      "",
      `Unfortunately ${name} couldn't take your booking for "${service}", so we've fully refunded your payment of ${refund}. Refunds usually appear within a few business days.`,
      "",
      "You're welcome to book another handyman anytime:",
      `${BASE_URL}/`,
      "",
      "— SLO Handyman",
    ].join("\n");

    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1a2233">
        <h2 style="margin:0 0 8px">Your booking was declined</h2>
        <p style="margin:0 0 14px">Hi ${escapeHtml(job.customerName || "there")}, unfortunately ${escapeHtml(name)} couldn't take your booking for <strong>${escapeHtml(service)}</strong>.</p>
        <p style="margin:0 0 16px;color:#374151">We've fully refunded your payment of <strong>${refund}</strong>. Refunds usually appear within a few business days.</p>
        <p style="margin:0 0 22px">${emailButton(`${BASE_URL}/`, "Find another handyman")}</p>
        <p style="margin:0;color:#9ca3af;font-size:13px">— SLO Handyman</p>
      </div>`;

    await sendEmail({ to: job.customerEmail, subject, text, html });
  } catch (err) {
    console.error("Decline notification failed:", err.message);
  }
}

// Handyman: the customer released payment — money is on its way.
async function notifyHandymanReleased(job) {
  try {
    const handyman = db.getHandyman(job.handymanId);
    if (!handyman || !handyman.email) return;
    const dashboardUrl = `${BASE_URL}/pro.html?id=${handyman.id}&token=${handyman.manageToken}`;
    const payout = `$${(job.handymanPayoutCents / 100).toFixed(2)}`;
    const service = job.service || "the job";
    const subject = `Payment released — ${payout} on its way`;

    const text = [
      `Hi ${handyman.name || "there"},`,
      "",
      `Great news — the customer released payment for "${service}". Your payout of ${payout} is on its way to your connected account.`,
      "",
      "See your jobs and payouts:",
      dashboardUrl,
      "",
      "— SLO Handyman",
    ].join("\n");

    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1a2233">
        <h2 style="margin:0 0 8px">You got paid!</h2>
        <p style="margin:0 0 14px">Hi ${escapeHtml(handyman.name || "there")}, the customer released payment for <strong>${escapeHtml(service)}</strong>.</p>
        <table style="width:100%;border-collapse:collapse;margin:0 0 18px">
          <tr><td style="padding:6px 0;color:#6b7280">Your payout</td><td style="padding:6px 0;text-align:right;font-weight:700">${payout}</td></tr>
        </table>
        <p style="margin:0 0 16px;color:#374151">It's on its way to your connected payout account.</p>
        <p style="margin:0 0 22px">${emailButton(dashboardUrl, "View my jobs")}</p>
        <p style="margin:0;color:#9ca3af;font-size:13px">— SLO Handyman</p>
      </div>`;

    await sendEmail({ to: handyman.email, subject, text, html });
  } catch (err) {
    console.error("Release notification failed:", err.message);
  }
}

const app = express();

// --- Stripe webhook (must be BEFORE express.json so we get the raw body) ---
app.post("/webhook", express.raw({ type: "application/json" }), (req, res) => {
  if (!stripe) return res.status(400).send("Stripe not configured");
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  let event;
  try {
    if (secret) {
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers["stripe-signature"],
        secret
      );
    } else {
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === "checkout.session.completed") {
    markSessionPaid(event.data.object).catch((e) => console.error(e));
  }

  res.json({ received: true });
});

// Larger limit so handymen can upload a (client-compressed) profile photo.
app.use(express.json({ limit: "6mb" }));
app.use(express.static(PUBLIC_DIR));
// Serve uploaded photos from the uploads directory (which may be on a persistent disk).
app.use("/uploads", express.static(UPLOADS_DIR));

// --- Helpers --------------------------------------------------------------

function requireAdmin(req, res) {
  const token = req.query.token || req.headers["x-admin-token"] || req.body?.token;
  if (token !== ADMIN_TOKEN) {
    res.status(401).json({ error: "Wrong password." });
    return false;
  }
  return true;
}

function heldJobsForHandyman(handymanId) {
  return db
    .listJobsForHandyman(handymanId)
    .filter((j) => j.status === "paid" || j.status === "accepted" || j.status === "work_done");
}

async function removeHandymanAccount(h) {
  if (stripe && h.stripeAccountId) {
    try {
      await stripe.accounts.del(h.stripeAccountId);
    } catch (e) {
      console.error("Stripe account delete failed:", e.message);
    }
  }
  for (const e of ["png", "jpg", "webp"]) {
    const old = path.join(UPLOADS_DIR, `${h.id}.${e}`);
    if (fs.existsSync(old)) {
      try { fs.unlinkSync(old); } catch {}
    }
  }
  db.deleteHandyman(h.id);
  if (h.userId) db.deleteUser(h.userId);
}

function requireStripe(res) {
  if (!stripe) {
    res.status(503).json({
      error:
        "Payments are not set up yet. Add your Stripe keys to the .env file to enable hiring and payouts.",
    });
    return false;
  }
  return true;
}

// Marks a job paid and records the charge id so we can release funds later.
async function markSessionPaid(session) {
  const job = db.getJobBySession(session.id);
  if (!job || job.status !== "pending") return job;
  let chargeId = null;
  const piId = session.payment_intent;
  try {
    if (stripe && piId) {
      const pi = await stripe.paymentIntents.retrieve(piId);
      chargeId = pi.latest_charge || pi.charges?.data?.[0]?.id || null;
    }
  } catch (e) {
    console.error("Could not retrieve payment intent:", e.message);
  }
  const updated = db.updateJob(job.id, {
    status: "paid",
    paidAt: Date.now(),
    stripePaymentIntentId: piId,
    stripeChargeId: chargeId,
  });
  // Let the handyman know a new booking is waiting. Best-effort (won't block
  // or fail the payment flow). The status guard above ensures this fires once.
  notifyHandymanNewBooking(updated).catch((e) => console.error(e));
  return updated;
}

async function syncHandymanStatus(handyman) {
  if (!stripe || !handyman.stripeAccountId) return handyman;
  try {
    const acct = await stripe.accounts.retrieve(handyman.stripeAccountId);
    // Ready to be hired when they can receive payouts AND the transfers
    // capability is active. (charges_enabled is irrelevant for receive-only.)
    const transfersActive = acct.capabilities && acct.capabilities.transfers === "active";
    return db.updateHandyman(handyman.id, {
      payoutsEnabled: !!acct.payouts_enabled && !!transfersActive,
      detailsSubmitted: !!acct.details_submitted,
    });
  } catch {
    return handyman;
  }
}

function publicHandyman(h) {
  return {
    id: h.id,
    name: h.name,
    city: h.city,
    services: h.services,
    hourlyRate: h.hourlyRate,
    bio: h.bio,
    photoUrl: h.photoUrl || null,
    payoutsEnabled: h.payoutsEnabled,
    ready: !!h.payoutsEnabled,
    // Legacy records without the field are treated as available.
    available: h.available !== false,
    rating: db.handymanRating(h.id),
  };
}

// --- Config ---------------------------------------------------------------

app.get("/api/config", (req, res) => {
  res.json({
    bookingFee: BOOKING_FEE,
    commissionPercent: COMMISSION_PERCENT,
    stripeConfigured: !!stripe,
    city: "San Luis Obispo",
    googleClientId: GOOGLE_CLIENT_ID || null,
    appleClientId: APPLE_CLIENT_ID || null,
  });
});

// --- Authentication (accounts) --------------------------------------------

function normalizeEmail(e) {
  return String(e || "").trim().toLowerCase();
}

function startSession(res, user) {
  const session = db.createSession(user.id);
  auth.setSessionCookie(res, session.token, { secure: COOKIE_SECURE });
}

// Who am I? Used by the frontend to show login state.
app.get("/api/auth/me", (req, res) => {
  const user = auth.getCurrentUser(req);
  res.json({ user: auth.publicUser(user) });
});

// Email + password signup. role = "customer" (default) or "handyman".
app.post("/api/auth/signup", (req, res) => {
  const { name, email, password, phone, role } = req.body || {};
  const em = normalizeEmail(email);
  if (!name || !em || !password) {
    return res.status(400).json({ error: "Name, email, and password are required." });
  }
  if (String(password).length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }
  if (db.getUserByEmail(em)) {
    return res.status(409).json({ error: "An account with this email already exists. Try logging in." });
  }
  const user = db.createUser({
    role: role === "handyman" ? "handyman" : "customer",
    name: String(name).trim(),
    email: em,
    phone: phone || "",
    provider: "password",
    passwordHash: auth.hashPassword(String(password)),
    zip: req.body.zip || "",
    preferredContact: req.body.preferredContact || "",
    referral: req.body.referral || "",
  });
  startSession(res, user);
  res.json({ user: auth.publicUser(user) });
});

// Email + password login.
app.post("/api/auth/login", (req, res) => {
  const { email, password } = req.body || {};
  const user = db.getUserByEmail(normalizeEmail(email));
  if (!user || user.provider !== "password" || !auth.verifyPassword(String(password || ""), user.passwordHash)) {
    return res.status(401).json({ error: "Incorrect email or password." });
  }
  startSession(res, user);
  res.json({ user: auth.publicUser(user) });
});

app.post("/api/auth/logout", (req, res) => {
  const token = auth.getSessionToken(req);
  if (token) db.deleteSession(token);
  auth.clearSessionCookie(res);
  res.json({ ok: true });
});

// Google Sign-In: the client sends the ID token (credential) from Google.
app.post("/api/auth/google", async (req, res) => {
  if (!GOOGLE_CLIENT_ID) {
    return res.status(503).json({ error: "Google sign-in isn't configured yet." });
  }
  try {
    const { credential, role } = req.body || {};
    const info = await auth.verifyGoogleIdToken(credential, GOOGLE_CLIENT_ID);
    const user = upsertSocialUser("google", info, role);
    startSession(res, user);
    res.json({ user: auth.publicUser(user) });
  } catch (err) {
    console.error("Google auth failed:", err.message);
    res.status(401).json({ error: "Could not verify your Google sign-in." });
  }
});

// Sign in with Apple: the client sends Apple's id_token.
app.post("/api/auth/apple", async (req, res) => {
  if (!APPLE_CLIENT_ID) {
    return res.status(503).json({ error: "Apple sign-in isn't configured yet." });
  }
  try {
    const { id_token, user: appleUser, role } = req.body || {};
    const info = await auth.verifyAppleIdToken(id_token, APPLE_CLIENT_ID);
    // Apple only sends the name on the very first authorization.
    if (appleUser && appleUser.name) {
      info.name = `${appleUser.name.firstName || ""} ${appleUser.name.lastName || ""}`.trim();
    }
    const user = upsertSocialUser("apple", info, role);
    startSession(res, user);
    res.json({ user: auth.publicUser(user) });
  } catch (err) {
    console.error("Apple auth failed:", err.message);
    res.status(401).json({ error: "Could not verify your Apple sign-in." });
  }
});

// Finds or creates a user for a verified social identity. Links by provider id,
// then by email (so a password account can also use social with the same email).
function upsertSocialUser(provider, info, role) {
  let user = db.getUserByProvider(provider, info.providerId);
  if (!user && info.email) {
    const byEmail = db.getUserByEmail(info.email);
    if (byEmail) {
      user = db.updateUser(byEmail.id, {
        provider,
        providerId: info.providerId,
        photoUrl: byEmail.photoUrl || info.photoUrl || null,
      });
    }
  }
  if (!user) {
    user = db.createUser({
      role: role === "handyman" ? "handyman" : "customer",
      name: info.name || (info.email ? info.email.split("@")[0] : "Member"),
      email: info.email || "",
      provider,
      providerId: info.providerId,
      photoUrl: info.photoUrl || null,
    });
  }
  return user;
}

// --- Browse handymen ------------------------------------------------------

app.get("/api/handymen", (req, res) => {
  const handymen = db.listHandymen();
  res.json(handymen.map(publicHandyman));
});

app.get("/api/handymen/:id", (req, res) => {
  const h = db.getHandyman(req.params.id);
  if (!h) return res.status(404).json({ error: "Handyman not found" });
  res.json(publicHandyman(h));
});

// --- Join as a handyman (Stripe Connect onboarding) -----------------------

app.post("/api/handymen", async (req, res) => {
  try {
    const {
      name,
      email,
      phone,
      city,
      services,
      hourlyRate,
      bio,
      password,
      yearsExperience,
      licensed,
      insured,
      serviceAreas,
    } = req.body || {};
    if (!name || !email) {
      return res.status(400).json({ error: "Please enter your name and email." });
    }

    // Accounts are required: reuse the logged-in account, or create one from a
    // password. (The private dashboard link is still generated as a backup.)
    const em = normalizeEmail(email);
    let account = auth.getCurrentUser(req);
    if (!account) {
      if (!password) {
        return res.status(400).json({ error: "Please create a password (or log in) to set up your handyman account." });
      }
      if (String(password).length < 8) {
        return res.status(400).json({ error: "Password must be at least 8 characters." });
      }
      if (db.getUserByEmail(em)) {
        return res.status(409).json({ error: "An account with this email already exists. Please log in first." });
      }
      account = db.createUser({
        role: "handyman",
        name: String(name).trim(),
        email: em,
        phone: phone || "",
        provider: "password",
        passwordHash: auth.hashPassword(String(password)),
      });
    }
    if (account && account.handymanId) {
      return res.status(409).json({ error: "You already have a handyman profile." });
    }

    const servicesList = Array.isArray(services)
      ? services
      : String(services || "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);

    let stripeAccountId = null;
    if (stripe) {
      const account = await stripe.accounts.create({
        type: "express",
        country: "US",
        email,
        business_type: "individual",
        // Escrow model: the platform takes the payment and later transfers the
        // handyman's share, so handymen only need the "transfers" capability
        // (to RECEIVE money). No card_payments = much lighter onboarding for them.
        capabilities: {
          transfers: { requested: true },
        },
        business_profile: {
          product_description: `Handyman services in ${city || "San Luis Obispo"}`,
        },
      });
      stripeAccountId = account.id;
    }

    const handyman = db.createHandyman({
      name,
      email,
      phone,
      city,
      services: servicesList,
      hourlyRate: hourlyRate ? Number(hourlyRate) : null,
      bio,
      stripeAccountId,
      userId: account ? account.id : null,
      yearsExperience: yearsExperience ? Number(yearsExperience) : null,
      licensed,
      insured,
      serviceAreas,
    });

    // Link the account to this new profile and log them in.
    if (account) {
      db.updateUser(account.id, { role: "handyman", handymanId: handyman.id });
      startSession(res, account);
    }

    let onboardingUrl = null;
    if (stripe) {
      const link = await stripe.accountLinks.create({
        account: stripeAccountId,
        refresh_url: `${BASE_URL}/api/handymen/${handyman.id}/onboarding-refresh`,
        return_url: `${BASE_URL}/onboard-complete?id=${handyman.id}`,
        type: "account_onboarding",
      });
      onboardingUrl = link.url;
    }

    res.json({
      handyman: publicHandyman(handyman),
      onboardingUrl,
      manageToken: handyman.manageToken,
      manageUrl: `${BASE_URL}/pro.html?id=${handyman.id}&token=${handyman.manageToken}`,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Stripe sends the user here if the onboarding link expires — make a fresh one.
app.get("/api/handymen/:id/onboarding-refresh", async (req, res) => {
  const h = db.getHandyman(req.params.id);
  if (!h || !stripe || !h.stripeAccountId) return res.redirect("/join.html");
  const link = await stripe.accountLinks.create({
    account: h.stripeAccountId,
    refresh_url: `${BASE_URL}/api/handymen/${h.id}/onboarding-refresh`,
    return_url: `${BASE_URL}/onboard-complete?id=${h.id}`,
    type: "account_onboarding",
  });
  res.redirect(link.url);
});

// Stripe returns the user here after onboarding — sync their status.
app.get("/onboard-complete", async (req, res) => {
  const h = db.getHandyman(req.query.id);
  if (h) await syncHandymanStatus(h);
  const token = h ? h.manageToken : "";
  res.redirect(`/join.html?onboarded=1&id=${req.query.id || ""}&token=${token}`);
});

app.get("/api/handymen/:id/status", async (req, res) => {
  const h = db.getHandyman(req.params.id);
  if (!h) return res.status(404).json({ error: "Not found" });
  const updated = await syncHandymanStatus(h);
  res.json(publicHandyman(updated));
});

// --- Handyman's private job dashboard (protected by manage token) ----------

function authHandyman(req) {
  const h = db.getHandyman(req.params.id);
  if (!h) return null;
  // Way 1: the private manage token (link-based access, still supported).
  const token = req.query.token || req.body?.token || req.headers["x-manage-token"];
  if (token && token === h.manageToken) return h;
  // Way 2: a logged-in account that owns this handyman profile.
  const user = auth.getCurrentUser(req);
  if (user && (user.handymanId === h.id || h.userId === user.id)) return h;
  return null;
}

app.get("/api/handymen/:id/jobs", (req, res) => {
  const h = authHandyman(req);
  if (!h) return res.status(401).json({ error: "Invalid or missing access link." });
  const jobs = db.listJobsForHandyman(h.id);
  res.json({
    handyman: {
      id: h.id,
      name: h.name,
      email: h.email,
      phone: h.phone || "",
      city: h.city || "",
      services: h.services || [],
      hourlyRate: h.hourlyRate,
      bio: h.bio || "",
      photoUrl: h.photoUrl || null,
      ready: !!h.payoutsEnabled,
      available: h.available !== false,
      rating: db.handymanRating(h.id),
    },
    jobs: jobs
      // Only reveal booked (paid) jobs and their contact details once money changed hands.
      .filter((j) => j.status !== "pending")
      .map((j) => ({
        id: j.id,
        date: j.createdAt,
        status: j.status,
        service: j.service,
        description: j.description,
        scheduledFor: j.scheduledFor,
        jobAmount: j.jobAmountCents / 100,
        commission: j.commissionCents / 100,
        yourPayout: j.handymanPayoutCents / 100,
        rating: j.rating,
        reviewNote: j.reviewNote,
        customer: {
          name: j.customerName,
          email: j.customerEmail,
          phone: j.customerPhone,
        },
      })),
  });
});

// Handyman accepts a new booking. Moves it from "paid" (awaiting response) to
// "accepted" (the job is on). Money stays held in escrow until the customer releases it.
app.post("/api/handymen/:id/jobs/:jobId/accept", (req, res) => {
  const h = authHandyman(req);
  if (!h) return res.status(401).json({ error: "Invalid or missing access link." });
  const job = db.getJob(req.params.jobId);
  if (!job || job.handymanId !== h.id) {
    return res.status(404).json({ error: "Job not found." });
  }
  if (job.status !== "paid") {
    return res.status(400).json({ error: "Only new, unaccepted bookings can be accepted." });
  }
  const updated = db.updateJob(job.id, { status: "accepted", acceptedAt: Date.now() });
  notifyCustomerAccepted(updated).catch((e) => console.error(e));
  res.json({ ok: true, status: updated.status });
});

// Handyman declines a new booking. The customer is fully refunded (job amount +
// booking fee) since no work will be done.
app.post("/api/handymen/:id/jobs/:jobId/decline", async (req, res) => {
  const h = authHandyman(req);
  if (!h) return res.status(401).json({ error: "Invalid or missing access link." });
  const job = db.getJob(req.params.jobId);
  if (!job || job.handymanId !== h.id) {
    return res.status(404).json({ error: "Job not found." });
  }
  if (job.status !== "paid") {
    return res.status(400).json({ error: "Only new, unaccepted bookings can be declined." });
  }

  // Refund the customer's full payment. Money is still in the platform balance
  // (escrow), so a straight refund of the payment intent returns everything.
  if (stripe && job.stripePaymentIntentId) {
    try {
      const refund = await stripe.refunds.create({
        payment_intent: job.stripePaymentIntentId,
      });
      db.updateJob(job.id, { stripeRefundId: refund.id });
    } catch (err) {
      console.error("Refund failed:", err.message);
      return res.status(500).json({ error: "Couldn't process the refund. Please try again." });
    }
  }

  const updated = db.updateJob(job.id, { status: "declined", declinedAt: Date.now() });
  notifyCustomerDeclined(updated).catch((e) => console.error(e));
  res.json({ ok: true, status: updated.status });
});

// Handyman signals the work is finished. This does NOT release money — it just
// nudges the customer to confirm and release the escrowed payment.
app.post("/api/handymen/:id/jobs/:jobId/work-done", (req, res) => {
  const h = authHandyman(req);
  if (!h) return res.status(401).json({ error: "Invalid or missing access link." });
  const job = db.getJob(req.params.jobId);
  if (!job || job.handymanId !== h.id) {
    return res.status(404).json({ error: "Job not found." });
  }
  if (job.status !== "accepted") {
    return res.status(400).json({ error: "Only accepted, in-progress jobs can be marked as done." });
  }
  const updated = db.updateJob(job.id, { status: "work_done", workDoneAt: Date.now() });
  res.json({ ok: true, status: updated.status });
});

// Handyman updates their own public profile (name, services, rate, bio, etc.).
app.put("/api/handymen/:id/profile", async (req, res) => {
  const h = authHandyman(req);
  if (!h) return res.status(401).json({ error: "Invalid or missing access link." });

  const { name, phone, city, services, hourlyRate, bio } = req.body || {};
  const updates = {};

  if (name !== undefined) {
    const n = String(name).trim();
    if (!n) return res.status(400).json({ error: "Name can't be empty." });
    updates.name = n;
  }
  if (phone !== undefined) updates.phone = String(phone).trim();
  if (city !== undefined) updates.city = String(city).trim() || "San Luis Obispo";
  if (bio !== undefined) updates.bio = String(bio).trim();
  if (services !== undefined) {
    updates.services = Array.isArray(services)
      ? services.map((s) => String(s).trim()).filter(Boolean)
      : String(services)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
  }
  if (hourlyRate !== undefined) {
    if (hourlyRate === "" || hourlyRate === null) {
      updates.hourlyRate = null;
    } else {
      const rate = Number(hourlyRate);
      if (!Number.isFinite(rate) || rate <= 0) {
        return res.status(400).json({ error: "Enter a valid hourly rate." });
      }
      updates.hourlyRate = rate;
    }
  }

  const updated = db.updateHandyman(h.id, updates);

  // Best-effort: keep the Stripe account's description in sync. Never block on it.
  if (stripe && updated.stripeAccountId) {
    try {
      await stripe.accounts.update(updated.stripeAccountId, {
        business_profile: {
          product_description: `Handyman services in ${updated.city || "San Luis Obispo"}`,
        },
      });
    } catch (e) {
      console.error("Stripe profile sync failed:", e.message);
    }
  }

  res.json({
    ok: true,
    handyman: {
      id: updated.id,
      name: updated.name,
      email: updated.email,
      phone: updated.phone || "",
      city: updated.city || "",
      services: updated.services || [],
      hourlyRate: updated.hourlyRate,
      bio: updated.bio || "",
    },
  });
});

// Handyman toggles whether they're currently taking new requests.
app.put("/api/handymen/:id/availability", (req, res) => {
  const h = authHandyman(req);
  if (!h) return res.status(401).json({ error: "Invalid or missing access link." });
  const available = !!(req.body && req.body.available);
  const updated = db.updateHandyman(h.id, { available });
  res.json({ ok: true, available: updated.available });
});

// Handyman uploads/replaces their profile photo. The client compresses the
// image first and sends a small base64 data URL, so no multipart parsing needed.
app.post("/api/handymen/:id/photo", (req, res) => {
  const h = authHandyman(req);
  if (!h) return res.status(401).json({ error: "Invalid or missing access link." });

  const { image } = req.body || {};
  const match = /^data:image\/(png|jpe?g|webp);base64,(.+)$/i.exec(image || "");
  if (!match) {
    return res.status(400).json({ error: "Please choose a PNG, JPG, or WEBP image." });
  }
  const ext = match[1].toLowerCase() === "jpeg" ? "jpg" : match[1].toLowerCase();
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length > 4 * 1024 * 1024) {
    return res.status(413).json({ error: "That image is too large. Try a smaller one." });
  }

  // Remove any previous photo (extension may differ) to avoid orphans.
  for (const e of ["png", "jpg", "webp"]) {
    const old = path.join(UPLOADS_DIR, `${h.id}.${e}`);
    if (fs.existsSync(old)) {
      try { fs.unlinkSync(old); } catch {}
    }
  }

  fs.writeFileSync(path.join(UPLOADS_DIR, `${h.id}.${ext}`), buffer);
  const photoUrl = `/uploads/${h.id}.${ext}?v=${Date.now()}`;
  db.updateHandyman(h.id, { photoUrl });
  res.json({ ok: true, photoUrl });
});

// Handyman permanently deletes their own account (profile + login).
app.delete("/api/handymen/:id", async (req, res) => {
  const h = authHandyman(req);
  if (!h) return res.status(401).json({ error: "Invalid or missing access link." });

  const activeJobs = heldJobsForHandyman(h.id);
  if (activeJobs.length) {
    return res.status(409).json({
      error:
        "You have active jobs with payments held in escrow. Please finish those jobs and have the customer release payment before deleting your account.",
    });
  }

  await removeHandymanAccount(h);

  // End the current session too.
  const token = auth.getSessionToken(req);
  if (token) db.deleteSession(token);
  auth.clearSessionCookie(res);

  res.json({ ok: true });
});

// --- Hire + pay (Stripe Checkout with $5 fee + commission) ----------------

app.post("/api/checkout", async (req, res) => {
  if (!requireStripe(res)) return;
  try {
    // Accounts are required to book: the customer must be logged in.
    const customer = auth.getCurrentUser(req);
    if (!customer) {
      return res.status(401).json({ error: "Please log in or create an account to book." });
    }

    const {
      handymanId,
      jobAmount,
      estimatedHours,
      hourlyRate,
      service,
      description,
      scheduledFor,
      customerName,
      customerEmail,
      customerPhone,
    } = req.body || {};

    // Fall back to the account's details when the form leaves them blank.
    const custName = customerName || customer.name || "";
    const custEmail = customerEmail || customer.email || "";
    const custPhone = customerPhone || customer.phone || "";

    const handyman = db.getHandyman(handymanId);
    if (!handyman) return res.status(404).json({ error: "Handyman not found." });

    await syncHandymanStatus(handyman);
    const fresh = db.getHandyman(handymanId);
    if (!fresh.stripeAccountId || !fresh.payoutsEnabled) {
      return res.status(400).json({
        error:
          "This handyman hasn't finished setting up payments yet, so they can't be hired right now.",
      });
    }
    if (fresh.available === false) {
      return res.status(400).json({
        error:
          "This handyman isn't taking new requests right now. Please check back later or choose another handyman.",
      });
    }

    const amount = Number(jobAmount);
    if (!amount || amount < 1) {
      return res.status(400).json({ error: "Please enter a valid job amount." });
    }

    const jobAmountCents = Math.round(amount * 100);
    const commissionCents = Math.round(jobAmountCents * (COMMISSION_PERCENT / 100));
    const platformTotalCents = BOOKING_FEE_CENTS + commissionCents;
    const totalChargedCents = jobAmountCents + BOOKING_FEE_CENTS;
    const handymanPayoutCents = jobAmountCents - commissionCents;

    const job = db.createJob({
      handymanId: fresh.id,
      handymanName: fresh.name,
      customerUserId: customer.id,
      customerName: custName,
      customerEmail: custEmail,
      customerPhone: custPhone,
      service,
      description,
      scheduledFor,
      jobAmountCents,
      bookingFeeCents: BOOKING_FEE_CENTS,
      commissionCents,
      platformTotalCents,
      estimatedHours: estimatedHours ? Number(estimatedHours) : null,
      hourlyRateSnapshot: hourlyRate ? Number(hourlyRate) : fresh.hourlyRate || null,
      handymanPayoutCents,
      totalChargedCents,
    });

    // ESCROW: charge the full amount to the PLATFORM account (no transfer_data /
    // application_fee). The money is held by us and only transferred to the
    // handyman when the customer releases payment after the job is done.
    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      customer_email: custEmail || undefined,
      line_items: [
        {
          price_data: {
            currency: "usd",
            product_data: {
              name: `${service || "Handyman service"} — ${fresh.name}`,
              description: description || undefined,
            },
            unit_amount: jobAmountCents,
          },
          quantity: 1,
        },
        {
          price_data: {
            currency: "usd",
            product_data: { name: "Booking fee" },
            unit_amount: BOOKING_FEE_CENTS,
          },
          quantity: 1,
        },
      ],
      payment_intent_data: {
        // transfer_group ties this charge to the job so we can pay the handyman later.
        transfer_group: job.id,
        metadata: { jobId: job.id },
      },
      metadata: { jobId: job.id },
      success_url: `${BASE_URL}/success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${BASE_URL}/handyman.html?id=${fresh.id}&canceled=1`,
    });

    db.updateJob(job.id, { stripeSessionId: session.id });
    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Used by the success page to confirm payment (also a fallback if no webhook).
app.get("/api/session/:sessionId", async (req, res) => {
  if (!requireStripe(res)) return;
  try {
    const session = await stripe.checkout.sessions.retrieve(req.params.sessionId);
    if (session.payment_status === "paid") {
      await markSessionPaid(session);
    }
    const finalJob = db.getJobBySession(session.id);
    const handyman = finalJob ? db.getHandyman(finalJob.handymanId) : null;
    const paid = session.payment_status === "paid";
    res.json({
      paid,
      job: finalJob
        ? {
            id: finalJob.id,
            status: finalJob.status,
            handymanName: finalJob.handymanName,
            service: finalJob.service,
            scheduledFor: finalJob.scheduledFor,
            totalCharged: finalJob.totalChargedCents / 100,
            bookingFee: finalJob.bookingFeeCents / 100,
            jobAmount: finalJob.jobAmountCents / 100,
            handymanPayout: finalJob.handymanPayoutCents / 100,
            // The customer's private key to manage this booking (release + review):
            manageToken: paid ? finalJob.reviewToken : null,
          }
        : null,
      // Only share the handyman's contact details after the booking is paid.
      handyman:
        paid && handyman
          ? { name: handyman.name, phone: handyman.phone, email: handyman.email }
          : null,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Reviews (customer rates the handyman 1-5 + optional note) -------------

app.post("/api/jobs/:id/review", (req, res) => {
  const job = db.getJob(req.params.id);
  const { rating, note } = req.body || {};
  if (!authCustomer(req, job)) {
    return res.status(401).json({ error: "Invalid or missing review link." });
  }
  if (job.status !== "completed") {
    return res.status(400).json({ error: "You can leave a review once the job is completed." });
  }
  const stars = Number(rating);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
    return res.status(400).json({ error: "Please choose a rating from 1 to 5 stars." });
  }
  const updated = db.updateJob(job.id, {
    rating: stars,
    reviewNote: (note || "").toString().slice(0, 1000),
    reviewedAt: Date.now(),
  });
  res.json({
    ok: true,
    rating: updated.rating,
    reviewNote: updated.reviewNote,
    handymanRating: db.handymanRating(job.handymanId),
  });
});

// Logged-in customer: all of their bookings in one place ("My bookings").
app.get("/api/my/bookings", (req, res) => {
  const user = auth.getCurrentUser(req);
  if (!user) return res.status(401).json({ error: "Please log in." });
  const jobs = db.listJobsForCustomer({ userId: user.id, email: user.email });
  res.json({
    bookings: jobs.map((j) => {
      const handyman = db.getHandyman(j.handymanId);
      return {
        id: j.id,
        token: j.reviewToken,
        status: j.status,
        service: j.service,
        scheduledFor: j.scheduledFor,
        jobAmount: j.jobAmountCents / 100,
        totalCharged: j.totalChargedCents / 100,
        rating: j.rating,
        date: j.createdAt,
        handymanName: j.handymanName,
        handymanPhoto: handyman ? handyman.photoUrl || null : null,
      };
    }),
  });
});

// Public list of reviews for a handyman (no customer identity revealed).
app.get("/api/handymen/:id/reviews", (req, res) => {
  const h = db.getHandyman(req.params.id);
  if (!h) return res.status(404).json({ error: "Not found" });
  const reviews = db
    .listJobsForHandyman(h.id)
    .filter((j) => typeof j.rating === "number")
    .map((j) => ({
      rating: j.rating,
      note: j.reviewNote,
      service: j.service,
      date: j.reviewedAt,
      customerName: (j.customerName || "").split(" ")[0] || "Customer",
    }));
  res.json({ rating: db.handymanRating(h.id), reviews });
});

// --- Customer booking management (escrow) ---------------------------------

function authCustomer(req, job) {
  if (!job) return false;
  // Way 1: the private review/booking token (link-based access).
  const token = req.query.token || req.body?.token;
  if (token && token === job.reviewToken) return true;
  // Way 2: a logged-in account that owns this booking.
  const user = auth.getCurrentUser(req);
  if (user) {
    if (job.customerUserId && job.customerUserId === user.id) return true;
    if ((job.customerEmail || "").toLowerCase() === (user.email || "").toLowerCase() && user.email) return true;
  }
  return false;
}

// Customer views their booking (status, contact, price) with their private token.
app.get("/api/jobs/:id", (req, res) => {
  const job = db.getJob(req.params.id);
  if (!authCustomer(req, job)) {
    return res.status(401).json({ error: "Invalid or missing booking link." });
  }
  const handyman = db.getHandyman(job.handymanId);
  res.json({
    id: job.id,
    status: job.status,
    service: job.service,
    description: job.description,
    scheduledFor: job.scheduledFor,
    estimatedHours: job.estimatedHours,
    hourlyRate: job.hourlyRateSnapshot,
    jobAmount: job.jobAmountCents / 100,
    bookingFee: job.bookingFeeCents / 100,
    totalCharged: job.totalChargedCents / 100,
    handymanPayout: job.handymanPayoutCents / 100,
    rating: job.rating,
    reviewNote: job.reviewNote,
    handyman: handyman
      ? { name: handyman.name, phone: handyman.phone, email: handyman.email }
      : null,
  });
});

// Customer releases the held payment to the handyman once the job is done.
app.post("/api/jobs/:id/release", async (req, res) => {
  const job = db.getJob(req.params.id);
  if (!authCustomer(req, job)) {
    return res.status(401).json({ error: "Invalid or missing booking link." });
  }
  if (job.status !== "accepted" && job.status !== "work_done") {
    return res.status(400).json({ error: "This booking isn't in a state that can be released." });
  }
  if (!requireStripe(res)) return;
  const handyman = db.getHandyman(job.handymanId);
  if (!handyman || !handyman.stripeAccountId) {
    return res.status(400).json({ error: "The handyman's payout account isn't set up." });
  }
  try {
    const transfer = await stripe.transfers.create({
      amount: job.handymanPayoutCents,
      currency: "usd",
      destination: handyman.stripeAccountId,
      transfer_group: job.id,
      // Pull from the specific charge so it works even before the balance settles.
      ...(job.stripeChargeId ? { source_transaction: job.stripeChargeId } : {}),
      metadata: { jobId: job.id },
    });
    const updated = db.updateJob(job.id, {
      status: "completed",
      releasedAt: Date.now(),
      stripeTransferId: transfer.id,
    });
    notifyHandymanReleased(updated).catch((e) => console.error(e));
    res.json({ ok: true, status: updated.status });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// --- Custom job requests ("Describe your job") ----------------------------

// Anyone can submit a request describing a job that doesn't fit a category.
// We capture it as a lead so the owner can match it to a handyman. Login is
// optional, but we link the request to the account when one is signed in.
app.post("/api/requests", (req, res) => {
  const { name, email, phone, category, description, area, timing, budget } = req.body || {};
  const user = auth.getCurrentUser(req);

  const finalName = String(name || user?.name || "").trim();
  const finalEmail = normalizeEmail(email || user?.email || "");
  const finalPhone = String(phone || user?.phone || "").trim();
  const desc = String(description || "").trim();

  if (!finalName) return res.status(400).json({ error: "Please tell us your name." });
  if (!finalEmail && !finalPhone) {
    return res.status(400).json({ error: "Please add an email or phone so a handyman can reach you." });
  }
  if (desc.length < 10) {
    return res.status(400).json({ error: "Please describe the job in a little more detail." });
  }

  const request = db.createRequest({
    userId: user ? user.id : null,
    name: finalName,
    email: finalEmail,
    phone: finalPhone,
    category: String(category || "").trim(),
    description: desc.slice(0, 2000),
    area: String(area || "").trim(),
    timing: String(timing || "").trim(),
    budget: String(budget || "").trim(),
  });

  res.json({ ok: true, id: request.id });
});

// --- Owner dashboard ------------------------------------------------------

app.get("/api/admin/data", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const jobs = db.listJobs();
  const paid = jobs.filter((j) => ["paid", "accepted", "work_done", "completed"].includes(j.status));
  const earningsCents = paid.reduce((sum, j) => sum + (j.platformTotalCents || 0), 0);
  const bookingFeesCents = paid.reduce((sum, j) => sum + (j.bookingFeeCents || 0), 0);
  const commissionCents = paid.reduce((sum, j) => sum + (j.commissionCents || 0), 0);
  const handymanUserIds = new Set(db.listHandymen().map((h) => h.userId).filter(Boolean));
  res.json({
    totals: {
      jobsPaid: paid.length,
      earnings: earningsCents / 100,
      bookingFees: bookingFeesCents / 100,
      commission: commissionCents / 100,
    },
    handymen: db.listHandymen().map((h) => {
      const held = heldJobsForHandyman(h.id).length;
      return {
        id: h.id,
        name: h.name,
        email: h.email,
        phone: h.phone || "",
        city: h.city || "",
        ready: !!h.payoutsEnabled,
        available: h.available !== false,
        heldJobs: held,
        createdAt: h.createdAt,
      };
    }),
    customers: db.listUsers()
      .filter((u) => !u.handymanId && !handymanUserIds.has(u.id))
      .map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        phone: u.phone || "",
        createdAt: u.createdAt,
      })),
    jobs: jobs.map((j) => ({
      id: j.id,
      date: j.createdAt,
      status: j.status,
      handymanName: j.handymanName,
      customerName: j.customerName,
      customerEmail: j.customerEmail,
      customerPhone: j.customerPhone,
      service: j.service,
      jobAmount: j.jobAmountCents / 100,
      bookingFee: j.bookingFeeCents / 100,
      commission: j.commissionCents / 100,
      yourEarnings: j.platformTotalCents / 100,
      handymanPayout: j.handymanPayoutCents / 100,
      rating: j.rating,
    })),
    requests: db.listRequests().map((r) => ({
      id: r.id,
      date: r.createdAt,
      status: r.status,
      name: r.name,
      email: r.email,
      phone: r.phone,
      category: r.category,
      description: r.description,
      area: r.area,
      timing: r.timing,
      budget: r.budget,
    })),
  });
});

app.delete("/api/admin/handymen/:id", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const h = db.getHandyman(req.params.id);
  if (!h) return res.status(404).json({ error: "Handyman not found." });
  const held = heldJobsForHandyman(h.id);
  if (held.length) {
    return res.status(409).json({
      error: `This handyman has ${held.length} job(s) with payment still held. Finish or refund those in Stripe before deleting the account.`,
    });
  }
  await removeHandymanAccount(h);
  res.json({ ok: true });
});

app.delete("/api/admin/customers/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const user = db.getUserById(req.params.id);
  if (!user) return res.status(404).json({ error: "Account not found." });
  if (user.handymanId) {
    return res.status(400).json({ error: "This login is a handyman account. Delete it from the Handymen list." });
  }
  db.deleteUser(user.id);
  res.json({ ok: true });
});

app.post("/api/admin/requests/:id/status", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { status } = req.body || {};
  if (!["new", "contacted", "closed"].includes(status)) {
    return res.status(400).json({ error: "Invalid status." });
  }
  const updated = db.updateRequest(req.params.id, { status });
  if (!updated) return res.status(404).json({ error: "Request not found." });
  res.json({ ok: true, status: updated.status });
});

// --- Contact form ----------------------------------------------------------

app.post("/api/contact", async (req, res) => {
  const { name, email, phone, subject, message } = req.body || {};

  if (!name || !name.trim()) {
    return res.status(400).json({ error: "Please enter your name." });
  }
  if (!email || !email.trim()) {
    return res.status(400).json({ error: "Please enter your email address." });
  }
  if (!subject) {
    return res.status(400).json({ error: "Please select a subject." });
  }
  if (!message || message.trim().length < 10) {
    return res.status(400).json({ error: "Please enter a message (at least 10 characters)." });
  }

  // Store the contact submission in the database
  const contact = db.createContact({
    name: name.trim(),
    email: email.trim().toLowerCase(),
    phone: (phone || "").trim(),
    subject,
    message: message.trim().slice(0, 5000),
  });

  // Forward to the support inbox (best-effort; the message is already saved).
  await sendEmail({
    to: CONTACT_EMAIL,
    replyTo: email.trim(),
    subject: `[Contact Form] ${subject} - ${name.trim()}`,
    text: `New contact form submission:\n\nName: ${name.trim()}\nEmail: ${email.trim()}\nPhone: ${phone || "Not provided"}\nSubject: ${subject}\n\nMessage:\n${message.trim()}`,
    html: `
      <h2>New Contact Form Submission</h2>
      <p><strong>Name:</strong> ${escapeHtml(name.trim())}</p>
      <p><strong>Email:</strong> <a href="mailto:${escapeHtml(email.trim())}">${escapeHtml(email.trim())}</a></p>
      <p><strong>Phone:</strong> ${escapeHtml(phone || "Not provided")}</p>
      <p><strong>Subject:</strong> ${escapeHtml(subject)}</p>
      <hr>
      <p><strong>Message:</strong></p>
      <p>${escapeHtml(message.trim()).replace(/\n/g, "<br>")}</p>
    `,
  });

  res.json({ ok: true, id: contact.id });
});

// Send anything else to the SPA-ish static pages.
app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));

app.listen(PORT, () => {
  console.log(`\n  SLO Handyman running at ${BASE_URL}`);
  console.log(`  Booking fee: $${BOOKING_FEE}  |  Commission: ${COMMISSION_PERCENT}%`);
  console.log(
    stripe
      ? "  Stripe: connected \u2713\n"
      : "  Stripe: NOT configured — add keys to .env to enable payments\n"
  );
});
