// Quote assistant: a short scripted chat that matches a San Luis Obispo County
// job to the next handyman in rotation, then hands off to the existing checkout.

import crypto from "crypto";
import express from "express";
import * as db from "./db.js";

export const CATEGORIES = [
  "Painting",
  "Plumbing",
  "Electrical",
  "Installation",
  "Repairs",
  "Moving",
  "Pressure Washing",
  "Landscaping",
  "Other",
];

const CATEGORY_WORDS = {
  Painting: ["paint", "primer", "stain"],
  Plumbing: ["plumb", "faucet", "toilet", "leak", "drain", "pipe", "sink", "water heater", "garbage disposal"],
  Electrical: ["electric", "outlet", "switch", "light", "wiring", "breaker", "fixture", "ceiling fan"],
  Installation: ["install", "mount", "tv", "shelf", "blind", "curtain", "appliance", "dishwasher"],
  Repairs: ["repair", "fix", "broken", "patch", "drywall", "door", "window", "fence"],
  Moving: ["mov", "haul", "furniture", "load", "unload"],
  "Pressure Washing": ["pressure", "power wash", "soft wash"],
  Landscaping: ["landscap", "lawn", "mow", "yard", "garden", "hedge", "sprinkler", "tree", "weed"],
};

// Towns and ZIP codes inside San Luis Obispo County only.
const PLACES = [
  { town: "San Luis Obispo", aliases: ["slo", "san luis obispo"], zips: ["93401", "93405", "93407", "93408", "93410"] },
  { town: "Los Osos", aliases: ["los osos", "baywood"], zips: ["93402", "93412"] },
  { town: "Morro Bay", aliases: ["morro bay"], zips: ["93442", "93443"] },
  { town: "Cayucos", aliases: ["cayucos"], zips: ["93430"] },
  { town: "Cambria", aliases: ["cambria"], zips: ["93428"] },
  { town: "San Simeon", aliases: ["san simeon"], zips: ["93452"] },
  { town: "Atascadero", aliases: ["atascadero"], zips: ["93422", "93423"] },
  { town: "Paso Robles", aliases: ["paso robles", "paso"], zips: ["93446", "93447"] },
  { town: "Templeton", aliases: ["templeton"], zips: ["93465"] },
  { town: "Santa Margarita", aliases: ["santa margarita"], zips: ["93453"] },
  { town: "San Miguel", aliases: ["san miguel"], zips: ["93451"] },
  { town: "Shandon", aliases: ["shandon"], zips: ["93461"] },
  { town: "Creston", aliases: ["creston"], zips: ["93432"] },
  { town: "Avila Beach", aliases: ["avila", "avila beach"], zips: ["93424"] },
  { town: "Pismo Beach", aliases: ["pismo", "pismo beach"], zips: ["93449"] },
  { town: "Grover Beach", aliases: ["grover", "grover beach"], zips: ["93433", "93483"] },
  { town: "Arroyo Grande", aliases: ["arroyo grande"], zips: ["93420", "93421"] },
  { town: "Oceano", aliases: ["oceano"], zips: ["93445"] },
  { town: "Nipomo", aliases: ["nipomo"], zips: ["93444"] },
];

const QUICK_TOWNS = [
  "San Luis Obispo", "Los Osos", "Morro Bay", "Pismo Beach", "Arroyo Grande",
  "Grover Beach", "Atascadero", "Paso Robles", "Cambria", "Cayucos", "Nipomo", "Oceano",
];

const FOUR_HOURS = 4 * 60 * 60 * 1000;
const hits = new Map();

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  return (fwd ? String(fwd).split(",")[0] : req.socket?.remoteAddress || "local").trim();
}

function rateLimited(req) {
  const ip = clientIp(req);
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 60 * 60 * 1000);
  if (recent.length >= 12) return true;
  recent.push(now);
  hits.set(ip, recent);
  return false;
}

function validEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15;
}

export function guessCategory(text) {
  const t = String(text || "").toLowerCase();
  let best = "Other";
  let bestScore = 0;
  for (const [cat, words] of Object.entries(CATEGORY_WORDS)) {
    const score = words.reduce((n, w) => n + (t.includes(w) ? 1 : 0), 0);
    if (score > bestScore) {
      best = cat;
      bestScore = score;
    }
  }
  return { category: best, confident: bestScore > 0 };
}

export function resolvePlace(input) {
  const raw = String(input || "").trim().toLowerCase();
  const zip = raw.replace(/\D/g, "");
  if (zip.length === 5) {
    const hit = PLACES.find((p) => p.zips.includes(zip));
    return hit ? { town: hit.town, zip } : null;
  }
  const hit = PLACES.find((p) => p.aliases.some((a) => raw === a || raw.includes(a)));
  return hit ? { town: hit.town, zip: "" } : null;
}

function areaFits(handyman, town) {
  const blob = `${handyman.city || ""} ${handyman.serviceAreas || ""}`.toLowerCase();
  const place = PLACES.find((p) => p.town === town);
  const names = place ? [place.town, ...place.aliases] : [town];
  return names.some((n) => n && blob.includes(n.toLowerCase()));
}

function categoryFits(handyman, category) {
  if (!category || category === "Other") return true;
  const want = category.toLowerCase();
  const services = (handyman.services || []).map((s) => String(s).toLowerCase());
  return services.some((s) => s.includes(want) || want.includes(s));
}

function openJobCount(handymanId) {
  return db.listJobsForHandyman(handymanId).filter((j) =>
    ["paid", "accepted", "work_done"].includes(j.status)
  ).length;
}

// Active, payout-ready handymen who fit the category. People who list the
// town come first. Inside each group, whoever was offered a job longest ago
// (or never) is next — so work rotates instead of sticking to one person.
export function rankHandymen({ category, town, skipIds = [] }) {
  const skip = new Set(skipIds);
  const eligible = db.listHandymen().filter((h) =>
    h.available !== false && h.payoutsEnabled && !skip.has(h.id) && categoryFits(h, category)
  );
  const local = eligible.filter((h) => areaFits(h, town));
  const pool = local.length ? local : eligible;
  const widened = local.length === 0 && eligible.length > 0;
  pool.sort((a, b) =>
    (a.lastOfferedAt || 0) - (b.lastOfferedAt || 0) ||
    openJobCount(a.id) - openJobCount(b.id) ||
    (a.createdAt || 0) - (b.createdAt || 0)
  );
  return { handymen: pool, widened };
}

function cardFor(h, { widened = false } = {}) {
  const rating = db.handymanRating(h.id);
  return {
    id: h.id,
    name: h.name,
    city: h.city || "",
    services: h.services || [],
    hourlyRate: h.hourlyRate || null,
    photoUrl: h.photoUrl || null,
    rating,
    widened,
  };
}

function laHour(ts) {
  const part = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(ts)).find((p) => p.type === "hour");
  return Number(part?.value || 0);
}

function laWeekday(ts) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "short",
  }).format(new Date(ts));
}

function nextMorning(from, weekdaysOnly) {
  for (let i = 1; i <= 80; i++) {
    const ts = from + i * 60 * 60 * 1000;
    if (laHour(ts) !== 9) continue;
    if (weekdaysOnly && (laWeekday(ts) === "Sat" || laWeekday(ts) === "Sun")) continue;
    return ts;
  }
  return from + 15 * 60 * 60 * 1000;
}

export function offerDeadline(urgency, from = Date.now()) {
  const hour = laHour(from);
  const evening = hour >= 18 || hour < 7;
  if (urgency === "flexible") return nextMorning(from, true);
  if (evening) return nextMorning(from, false);
  return from + FOUR_HOURS;
}

function note(request, role, text) {
  const transcript = [...(request.transcript || []), { role, text, at: Date.now() }];
  return transcript.slice(-80);
}

function loadByToken(token) {
  return db.getJobRequestByToken(token);
}

export function createAssistRoutes(app, deps) {
  const { auth, sendEmail, escapeHtml, emailButton, baseUrl, contactEmail, stripe, normalizeEmail } = deps;

  function authRequest(req) {
    const token = (req.body && req.body.token) || req.query.token;
    return loadByToken(token);
  }

  app.get("/request", (req, res) => {
    res.sendFile(deps.requestPage);
  });

  app.get("/api/assist/places", (req, res) => {
    res.json({ towns: QUICK_TOWNS, categories: CATEGORIES });
  });

  app.post("/api/assist/start", (req, res) => {
    if (req.body && req.body.website) return res.json({ ok: true });
    if (rateLimited(req)) {
      return res.status(429).json({ error: "Too many requests. Please try again in a little while." });
    }
    const description = String((req.body && req.body.description) || "").trim();
    if (description.length < 8) {
      return res.status(400).json({ error: "Tell us a little more about the job." });
    }
    const guess = guessCategory(description);
    const request = db.createJobRequest({
      description: description.slice(0, 2000),
      transcript: [{ role: "customer", text: description.slice(0, 2000), at: Date.now() }],
    });
    db.updateJobRequest(request.id, { category: guess.confident ? guess.category : "" });
    res.json({
      token: request.accessToken,
      category: guess.category,
      confident: guess.confident,
      categories: CATEGORIES,
    });
  });

  app.post("/api/assist/contact", (req, res) => {
    const request = authRequest(req);
    if (!request) return res.status(401).json({ error: "This quote session expired. Please start again." });
    const name = String(req.body.name || "").trim().slice(0, 80);
    const phone = String(req.body.phone || "").trim().slice(0, 30);
    const email = normalizeEmail(req.body.email || "");
    if (!validPhone(phone)) return res.status(400).json({ error: "Please enter a valid phone number." });
    if (email && !validEmail(email)) return res.status(400).json({ error: "Please enter a valid email address." });
    const updated = db.updateJobRequest(request.id, {
      customerName: name,
      customerPhone: phone,
      customerEmail: email,
      status: request.status === "new" ? "collecting" : request.status,
      transcript: note(request, "customer", `${name} · ${phone} · ${email}`),
    });
    res.json({ ok: true, status: updated.status });
  });

  app.post("/api/assist/category", (req, res) => {
    const request = authRequest(req);
    if (!request) return res.status(401).json({ error: "This quote session expired. Please start again." });
    const category = String(req.body.category || "");
    if (!CATEGORIES.includes(category)) return res.status(400).json({ error: "Please choose a category." });
    db.updateJobRequest(request.id, {
      category,
      transcript: note(request, "customer", category),
    });
    res.json({ ok: true, towns: QUICK_TOWNS });
  });

  app.post("/api/assist/place", (req, res) => {
    const request = authRequest(req);
    if (!request) return res.status(401).json({ error: "This quote session expired. Please start again." });
    const place = resolvePlace(req.body.place);
    if (!place) {
      return res.status(400).json({
        error: "We only take jobs in San Luis Obispo County. Please choose a town or ZIP in the county.",
      });
    }
    db.updateJobRequest(request.id, {
      town: place.town,
      zip: place.zip,
      transcript: note(request, "customer", place.zip ? `${place.town} ${place.zip}` : place.town),
    });
    res.json({ ok: true, town: place.town });
  });

  app.post("/api/assist/timing", (req, res) => {
    const request = authRequest(req);
    if (!request) return res.status(401).json({ error: "This quote session expired. Please start again." });
    const urgency = String(req.body.urgency || "");
    const allowed = ["today", "week", "flexible", "date"];
    if (!allowed.includes(urgency)) return res.status(400).json({ error: "Please choose when you need the work." });
    let scheduledFor = "";
    if (urgency === "date") {
      scheduledFor = String(req.body.date || "").slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(scheduledFor)) {
        return res.status(400).json({ error: "Please pick a date." });
      }
    }
    db.updateJobRequest(request.id, {
      urgency,
      scheduledFor,
      transcript: note(request, "customer", scheduledFor || urgency),
    });
    res.json({ ok: true });
  });

  app.post("/api/assist/match", (req, res) => {
    const request = authRequest(req);
    if (!request) return res.status(401).json({ error: "This quote session expired. Please start again." });
    if (!request.category || !request.town) {
      return res.status(400).json({ error: "Please finish the previous questions first." });
    }
    const { handymen, widened } = rankHandymen({ category: request.category, town: request.town });
    if (!handymen.length) {
      const updated = db.updateJobRequest(request.id, { status: "unmatched", candidates: [], assignedHandymanId: null });
      notifyAdminUnmatched(updated, "No handyman matched before checkout.").catch((e) => console.error(e));
      return res.json({ ok: true, match: null });
    }
    const ids = handymen.map((h) => h.id);
    const assigned = handymen[0];
    db.updateHandyman(assigned.id, { lastOfferedAt: Date.now() });
    db.updateJobRequest(request.id, {
      status: "matched",
      candidates: ids,
      assignedHandymanId: assigned.id,
    });
    res.json({
      ok: true,
      pick: cardFor(assigned, { widened }),
      others: handymen.slice(1, 3).map((h) => cardFor(h)),
      widened,
    });
  });

  app.post("/api/assist/choose", (req, res) => {
    const request = authRequest(req);
    if (!request) return res.status(401).json({ error: "This quote session expired. Please start again." });
    const handymanId = String(req.body.handymanId || "");
    if (!(request.candidates || []).includes(handymanId)) {
      return res.status(400).json({ error: "That handyman isn't one of the matches for this job." });
    }
    const handyman = db.getHandyman(handymanId);
    if (!handyman || handyman.available === false || !handyman.payoutsEnabled) {
      return res.status(400).json({ error: "That handyman isn't available right now." });
    }
    db.updateHandyman(handyman.id, { lastOfferedAt: Date.now() });
    const user = ensureCustomer(request, res);
    db.updateJobRequest(request.id, {
      assignedHandymanId: handyman.id,
      customerUserId: user ? user.id : request.customerUserId,
      status: "checkout",
    });
    res.json({
      ok: true,
      url: `${baseUrl()}/handyman.html?id=${encodeURIComponent(handyman.id)}&assist=${encodeURIComponent(request.accessToken)}`,
    });
  });

  app.get("/api/assist/prefill", (req, res) => {
    const request = loadByToken(req.query.token);
    if (!request) return res.status(404).json({ error: "Quote not found." });
    const timingLabel = {
      today: "Today / ASAP",
      week: "This week",
      flexible: "Flexible",
      date: request.scheduledFor || "Specific date",
    }[request.urgency] || "";
    res.json({
      handymanId: request.assignedHandymanId,
      customerName: request.customerName,
      customerEmail: request.customerEmail,
      customerPhone: request.customerPhone,
      service: request.category && request.category !== "Other" ? request.category : "Handyman job",
      description: [
        request.description,
        request.town ? `Location: ${request.town}${request.zip ? " " + request.zip : ""}` : "",
        timingLabel ? `Timing: ${timingLabel}` : "",
      ].filter(Boolean).join("\n\n"),
      scheduledFor: request.scheduledFor || "",
    });
  });

  function ensureCustomer(request, res) {
    const email = normalizeEmail(request.customerEmail);
    const accountEmail = email || `guest+${request.id}@customers.slohandyman.com`;
    const existing = db.getUserByEmail(accountEmail);
    if (existing) return existing;
    const user = db.createUser({
      role: "customer",
      name: request.customerName || "Customer",
      email: accountEmail,
      phone: request.customerPhone,
      provider: "password",
      passwordHash: auth.hashPassword(crypto.randomBytes(24).toString("hex")),
      zip: request.zip || "",
    });
    if (email) {
      const session = db.createSession(user.id);
      auth.setSessionCookie(res, session.token, { secure: deps.cookieSecure });
    }
    return user;
  }

  function bookingDescription(request) {
    const timingLabel = {
      today: "Today / ASAP",
      week: "This week",
      flexible: "Flexible",
      date: request.scheduledFor || "Specific date",
    }[request.urgency] || "";
    return [
      request.description,
      request.town ? `Location: ${request.town}${request.zip ? " " + request.zip : ""}` : "",
      timingLabel ? `Timing: ${timingLabel}` : "",
    ].filter(Boolean).join("\n\n");
  }

  async function notifyHandymanOffer(job, request) {
    const handyman = db.getHandyman(job.handymanId);
    if (!handyman || !handyman.email) return;
    const acceptUrl = `${baseUrl()}/api/jobs/${job.id}/offer?token=${job.offerToken}&action=accept`;
    const declineUrl = `${baseUrl()}/api/jobs/${job.id}/offer?token=${job.offerToken}&action=decline`;
    const payout = `$${((job.handymanPayoutCents || 0) / 100).toFixed(2)}`;
    const subject = "New job in your area — please accept or decline";
    const text = [
      `Hi ${handyman.name || "there"},`,
      "",
      `A customer booked "${job.service || "a job"}" and you are next in line.`,
      job.description || "",
      `Customer: ${job.customerName || "—"}`,
      `Phone: ${job.customerPhone || "—"}`,
      `Email: ${job.customerEmail || "—"}`,
      `Your payout if you accept: ${payout}`,
      "",
      `Accept: ${acceptUrl}`,
      `Decline: ${declineUrl}`,
      "",
      "If you don't reply in time, the job is offered to the next handyman. The customer's payment stays held until the work is done.",
      "",
      "— SLO Handyman",
    ].filter((l) => l !== "").join("\n");
    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1a2233">
        <h2 style="margin:0 0 8px">A job is waiting for you</h2>
        <p style="margin:0 0 12px">Hi ${escapeHtml(handyman.name || "there")}, a customer booked <strong>${escapeHtml(job.service || "a job")}</strong> and you are next in line.</p>
        <p style="margin:0 0 12px;white-space:pre-wrap">${escapeHtml(job.description || "")}</p>
        <table style="width:100%;border-collapse:collapse;margin:0 0 16px">
          <tr><td style="padding:6px 0;color:#6b7280">Customer</td><td style="padding:6px 0;text-align:right;font-weight:700">${escapeHtml(job.customerName || "—")}</td></tr>
          <tr><td style="padding:6px 0;color:#6b7280">Phone</td><td style="padding:6px 0;text-align:right;font-weight:700">${escapeHtml(job.customerPhone || "—")}</td></tr>
          <tr><td style="padding:6px 0;color:#6b7280">Email</td><td style="padding:6px 0;text-align:right;font-weight:700">${escapeHtml(job.customerEmail || "—")}</td></tr>
          <tr><td style="padding:6px 0;color:#6b7280">Your payout</td><td style="padding:6px 0;text-align:right;font-weight:700">${payout}</td></tr>
        </table>
        <p style="margin:0 0 10px">${emailButton(acceptUrl, "Accept this job")}</p>
        <p style="margin:0 0 16px"><a href="${declineUrl}" style="color:#6b7280">Decline</a></p>
        <p style="margin:0;color:#9ca3af;font-size:13px">If you don't reply in time, the job goes to the next handyman. Payment stays held until the work is done.<br>— SLO Handyman</p>
      </div>`;
    await sendEmail({ to: handyman.email, subject, text, html, replyTo: job.customerEmail || undefined });
    void request;
  }

  async function notifyCustomerMoved(job, handyman) {
    if (!job.customerEmail) return;
    const name = handyman?.name || "another local handyman";
    const subject = `We're asking ${name} to take your job`;
    const text = [
      `Hi ${job.customerName || "there"},`,
      "",
      `The previous handyman couldn't take your job, so we've asked ${name} to confirm it. You will not be charged again. Your payment stays held until the work is done.`,
      "",
      "— SLO Handyman",
    ].join("\n");
    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1a2233">
        <h2 style="margin:0 0 8px">Your job moved to the next handyman</h2>
        <p style="margin:0 0 14px">Hi ${escapeHtml(job.customerName || "there")}, the previous handyman couldn't take the job, so we've asked <strong>${escapeHtml(name)}</strong> to confirm it.</p>
        <p style="margin:0 0 16px;color:#374151">You will not be charged again. Your payment stays held until the work is done.</p>
        <p style="margin:0;color:#9ca3af;font-size:13px">— SLO Handyman</p>
      </div>`;
    await sendEmail({ to: job.customerEmail, subject, text, html });
  }

  async function notifyCustomerUnmatched(job) {
    if (!job.customerEmail) return;
    const refund = `$${((job.totalChargedCents || 0) / 100).toFixed(2)}`;
    const subject = "We couldn't place your job — full refund on the way";
    const text = [
      `Hi ${job.customerName || "there"},`,
      "",
      `None of the available handymen could take "${job.service || "your job"}", so we've refunded your payment of ${refund}. Refunds usually appear within a few business days.`,
      "",
      "You can browse handymen and book someone directly anytime:",
      baseUrl(),
      "",
      "— SLO Handyman",
    ].join("\n");
    const html = `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:520px;margin:0 auto;color:#1a2233">
        <h2 style="margin:0 0 8px">We couldn't place this job</h2>
        <p style="margin:0 0 14px">Hi ${escapeHtml(job.customerName || "there")}, none of the available handymen could take <strong>${escapeHtml(job.service || "your job")}</strong>.</p>
        <p style="margin:0 0 16px;color:#374151">We've refunded <strong>${refund}</strong>. Refunds usually appear within a few business days.</p>
        <p style="margin:0 0 22px">${emailButton(baseUrl() + "/", "Browse handymen")}</p>
        <p style="margin:0;color:#9ca3af;font-size:13px">— SLO Handyman</p>
      </div>`;
    await sendEmail({ to: job.customerEmail, subject, text, html });
  }

  async function notifyAdminUnmatched(request, reason) {
    const subject = `Unmatched quote: ${request.category || "job"} in ${request.town || "SLO County"}`;
    const lines = [
      reason,
      "",
      `Customer: ${request.customerName || "—"} · ${request.customerEmail || "—"} · ${request.customerPhone || "—"}`,
      `Category: ${request.category || "—"}`,
      `Town: ${request.town || "—"} ${request.zip || ""}`,
      `Job: ${request.description || "—"}`,
    ];
    await sendEmail({
      to: contactEmail,
      subject,
      text: lines.join("\n"),
      html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1a2233">${lines.map((l) => `<p style="margin:2px 0">${escapeHtml(l)}</p>`).join("")}</div>`,
      replyTo: request.customerEmail || undefined,
    });
  }

  async function refundJob(job) {
    if (stripe && job.stripePaymentIntentId && !job.stripeRefundId) {
      const refund = await stripe.refunds.create({ payment_intent: job.stripePaymentIntentId });
      db.updateJob(job.id, { stripeRefundId: refund.id });
    }
    return db.updateJob(job.id, { status: "declined", declinedAt: Date.now(), offerDeadlineAt: null });
  }

  async function offerTo(job, request, handyman, { moved = false } = {}) {
    const offerToken = crypto.randomBytes(16).toString("hex");
    const deadline = offerDeadline(request.urgency || "week");
    const history = [...(request.offerHistory || [])];
    history.push({ handymanId: handyman.id, offeredAt: Date.now(), response: "pending" });
    db.updateHandyman(handyman.id, { lastOfferedAt: Date.now() });
    const updatedJob = db.updateJob(job.id, {
      handymanId: handyman.id,
      handymanName: handyman.name,
      offerToken,
      offerDeadlineAt: deadline,
    });
    db.updateJobRequest(request.id, {
      assignedHandymanId: handyman.id,
      offerHistory: history,
      status: moved ? "reassigned" : "offered",
      jobId: job.id,
    });
    await notifyHandymanOffer(updatedJob, request);
    if (moved) await notifyCustomerMoved(updatedJob, handyman);
    return updatedJob;
  }

  function nextCandidate(request) {
    const tried = new Set((request.offerHistory || []).map((o) => o.handymanId));
    if (request.assignedHandymanId) tried.add(request.assignedHandymanId);
    const ids = request.candidates || [];
    for (const id of ids) {
      if (tried.has(id)) continue;
      const h = db.getHandyman(id);
      if (h && h.available !== false && h.payoutsEnabled) return h;
    }
    return null;
  }

  function closePendingOffer(request, handymanId, response) {
    const history = (request.offerHistory || []).map((o) =>
      o.handymanId === handymanId && o.response === "pending"
        ? { ...o, response, respondedAt: Date.now() }
        : o
    );
    return history;
  }

  async function advance(job, request, response) {
    const history = closePendingOffer(request, job.handymanId, response);
    const saved = db.updateJobRequest(request.id, { offerHistory: history });
    const next = nextCandidate(saved);
    if (next) return offerTo(job, saved, next, { moved: true });
    const refunded = await refundJob(job);
    db.updateJobRequest(request.id, { status: "unmatched", offerHistory: history });
    await notifyCustomerUnmatched(refunded);
    await notifyAdminUnmatched(db.getJobRequest(request.id), "Every matching handyman declined or timed out after payment.");
    return refunded;
  }

  function offerJob(req) {
    const job = db.getJob(req.params.id);
    const token = (req.query && req.query.token) || (req.body && req.body.token);
    if (!job || !job.offerToken || job.offerToken !== token) return null;
    return job;
  }

  app.get("/api/jobs/:id/offer", (req, res) => {
    const job = offerJob(req);
    if (!job) return res.status(401).type("html").send(page("This link is no longer valid.", false));
    if (job.status !== "paid") {
      return res.type("html").send(page("This job is no longer waiting for a response.", job.status === "accepted"));
    }
    const action = req.query.action === "decline" ? "decline" : "accept";
    const label = action === "decline" ? "Decline this job" : "Accept this job";
    res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SLO Handyman</title></head>
      <body style="font-family:Segoe UI,sans-serif;background:#f7f6f2;color:#1b2537;margin:0;padding:32px 18px">
      <div style="max-width:440px;margin:40px auto;background:#fff;border-radius:16px;padding:28px;box-shadow:0 6px 24px rgba(24,40,72,.08)">
      <h1 style="font-size:1.3rem;margin:0 0 8px">${escapeHtml(job.service || "Job request")}</h1>
      <p style="margin:0 0 16px;color:#41506a">${escapeHtml(job.description || "")}</p>
      <form method="POST" action="/api/jobs/${job.id}/offer">
        <input type="hidden" name="token" value="${escapeHtml(job.offerToken)}" />
        <input type="hidden" name="action" value="${action}" />
        <button type="submit" style="background:#1f2c4d;color:#fff;border:0;border-radius:10px;padding:12px 18px;font-weight:700;font-size:1rem">${label}</button>
      </form>
      </div></body></html>`);
  });

  app.post("/api/jobs/:id/offer", express.urlencoded({ extended: false }), async (req, res) => {
    const job = offerJob(req);
    if (!job) return res.status(401).type("html").send(page("This link is no longer valid.", false));
    if (job.status !== "paid") {
      return res.type("html").send(page("This job is no longer waiting for a response.", false));
    }
    try {
      if (req.body.action === "decline") {
        await handlePass(job, "declined");
        return res.type("html").send(page("You declined the job. If another handyman is available, we'll offer it to them.", true));
      }
      const updated = db.updateJob(job.id, { status: "accepted", acceptedAt: Date.now(), offerDeadlineAt: null });
      const request = job.requestId ? db.getJobRequest(job.requestId) : null;
      if (request) {
        db.updateJobRequest(request.id, {
          status: "accepted",
          offerHistory: closePendingOffer(request, job.handymanId, "accepted"),
        });
      }
      deps.notifyCustomerAccepted(updated).catch((e) => console.error(e));
      res.type("html").send(page("You accepted the job. The customer has been notified, and their payment stays held until the work is done.", true));
    } catch (err) {
      console.error(err);
      res.status(500).type("html").send(page("We couldn't update this job. Please try again from your dashboard.", false));
    }
  });

  async function handlePass(job, response) {
    const request = job.requestId ? db.getJobRequest(job.requestId) : null;
    if (!request) {
      const refunded = await refundJob(job);
      deps.notifyCustomerDeclined(refunded).catch((e) => console.error(e));
      return refunded;
    }
    return advance(job, request, response);
  }

  async function processOffers() {
    const now = Date.now();
    for (const job of db.listJobs()) {
      if (job.status !== "paid" || !job.requestId || !job.offerDeadlineAt || job.offerDeadlineAt > now) continue;
      try {
        await handlePass(job, "timeout");
        console.log(`Quote offer timed out for job ${job.id}`);
      } catch (err) {
        console.error(`Quote reassign failed for ${job.id}:`, err.message);
      }
    }
    await maybeDailySummary();
  }

  async function maybeDailySummary() {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/Los_Angeles",
      hour: "2-digit",
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const get = (t) => parts.find((p) => p.type === t)?.value;
    const hour = Number(get("hour") || 0);
    const day = `${get("year")}-${get("month")}-${get("day")}`;
    if (hour < 8) return;
    if ((db.getMeta().dailySummaryOn || "") === day) return;
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const requests = db.listJobRequests().filter((r) => r.createdAt >= since);
    const jobs = db.listJobs().filter((j) => j.requestId && (j.paidAt || j.createdAt) >= since);
    const lines = [
      `Quote assistant summary for ${day}`,
      "",
      `New quote chats: ${requests.length}`,
      `Paid bookings from quotes: ${jobs.filter((j) => j.status !== "pending" && j.status !== "declined").length}`,
      `Reassigned: ${requests.filter((r) => r.status === "reassigned" || (r.offerHistory || []).length > 1).length}`,
      `Refunded / unmatched: ${requests.filter((r) => r.status === "unmatched").length}`,
      `Accepted: ${requests.filter((r) => r.status === "accepted").length}`,
    ];
    if (!requests.length && !jobs.length) {
      db.setMeta({ dailySummaryOn: day });
      return;
    }
    await sendEmail({
      to: contactEmail,
      subject: `Daily quote summary — ${day}`,
      text: lines.join("\n"),
      html: `<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1a2233">${lines.map((l) => `<p style="margin:2px 0">${escapeHtml(l)}</p>`).join("")}</div>`,
    });
    db.setMeta({ dailySummaryOn: day });
  }

  app.post("/api/admin/assists/:id/assign", async (req, res) => {
    if (!deps.requireAdmin(req, res)) return;
    const request = db.getJobRequest(req.params.id);
    if (!request) return res.status(404).json({ error: "Quote not found." });
    const handyman = db.getHandyman(req.body.handymanId);
    if (!handyman) return res.status(404).json({ error: "Handyman not found." });
    const candidates = [handyman.id, ...(request.candidates || []).filter((id) => id !== handyman.id)];
    db.updateJobRequest(request.id, { candidates, assignedHandymanId: handyman.id });
    const job = request.jobId ? db.getJob(request.jobId) : null;
    if (job && job.status === "paid") {
      try {
        await offerTo(job, db.getJobRequest(request.id), handyman, { moved: true });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }
    res.json({ ok: true });
  });

  setInterval(() => { processOffers().catch((e) => console.error(e)); }, 5 * 60 * 1000);

  return {
    bookingDescription,
    onPaid: async (job) => {
      if (!job.requestId) return;
      const request = db.getJobRequest(job.requestId);
      if (!request) return;
      const handyman = db.getHandyman(job.handymanId);
      if (!handyman) return;
      await offerTo(job, request, handyman, { moved: false });
    },
    handlePass,
    prepareCheckout(req, res) {
      const token = req.body && req.body.assistToken;
      if (!token) return null;
      const request = loadByToken(token);
      if (!request) {
        const err = new Error("This quote session expired. Please start again.");
        err.status = 400;
        throw err;
      }
      if (request.assignedHandymanId && request.assignedHandymanId !== req.body.handymanId) {
        const err = new Error("Please book the handyman selected for this quote.");
        err.status = 400;
        throw err;
      }
      const user = ensureCustomer(request, res);
      db.updateJobRequest(request.id, { customerUserId: user.id, status: "checkout", jobId: request.jobId });
      return { request, user, description: bookingDescription(request) };
    },
    publicList() {
      return db.listJobRequests().map((r) => {
        const assigned = r.assignedHandymanId ? db.getHandyman(r.assignedHandymanId) : null;
        return {
          id: r.id,
          date: r.createdAt,
          status: r.status,
          name: r.customerName,
          email: r.customerEmail,
          phone: r.customerPhone,
          category: r.category,
          town: r.town,
          zip: r.zip,
          urgency: r.urgency,
          description: r.description,
          assignedName: assigned ? assigned.name : "",
          offerCount: (r.offerHistory || []).length,
        };
      });
    },
  };
}

function page(message, ok) {
  const color = ok ? "#17924a" : "#8a5a00";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SLO Handyman</title></head>
  <body style="font-family:Segoe UI,sans-serif;background:#f7f6f2;color:#1b2537;margin:0;padding:32px 18px">
  <div style="max-width:440px;margin:40px auto;background:#fff;border-radius:16px;padding:28px;box-shadow:0 6px 24px rgba(24,40,72,.08)">
  <p style="margin:0 0 8px;font-weight:800;color:${color}">${ok ? "All set" : "Something needs attention"}</p>
  <p style="margin:0 0 18px;line-height:1.5">${message}</p>
  <a href="/" style="color:#1f2c4d;font-weight:700">Back to SLO Handyman</a>
  </div></body></html>`;
}
