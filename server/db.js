// A tiny file-based data store. Good enough to launch a marketplace MVP.
// When you outgrow it, the same functions can be swapped for a real database
// (Postgres, SQLite, etc.) without changing the rest of the app.

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// On Render, use the persistent disk at /data; locally, use the project's data folder.
const DATA_DIR = process.env.RENDER ? "/data" : path.join(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

const DEFAULT_DATA = { handymen: [], jobs: [], users: [], sessions: [], requests: [], contacts: [] };

function ensureFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify(DEFAULT_DATA, null, 2));
  }
}

function read() {
  ensureFile();
  try {
    const raw = fs.readFileSync(DB_FILE, "utf8").replace(/^\uFEFF/, "");
    const data = JSON.parse(raw);
    return {
      handymen: data.handymen || [],
      jobs: data.jobs || [],
      users: data.users || [],
      sessions: data.sessions || [],
      requests: data.requests || [],
      contacts: data.contacts || [],
    };
  } catch {
    return { handymen: [], jobs: [], users: [], sessions: [], requests: [], contacts: [] };
  }
}

function write(data) {
  ensureFile();
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function id(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

// --- Handymen -------------------------------------------------------------

export function listHandymen({ onlyActive = false } = {}) {
  const { handymen } = read();
  const sorted = handymen.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  return onlyActive ? sorted.filter((h) => h.payoutsEnabled) : sorted;
}

export function getHandyman(handymanId) {
  return read().handymen.find((h) => h.id === handymanId) || null;
}

export function createHandyman(fields) {
  const data = read();
  const handyman = {
    id: id("hm"),
    createdAt: Date.now(),
    userId: fields.userId || null,
    name: fields.name,
    email: fields.email,
    city: fields.city || "San Luis Obispo",
    services: fields.services || [],
    hourlyRate: fields.hourlyRate || null,
    bio: fields.bio || "",
    phone: fields.phone || "",
    // Extra onboarding details shown to build customer trust.
    yearsExperience: fields.yearsExperience || null,
    licensed: !!fields.licensed,
    insured: !!fields.insured,
    serviceAreas: fields.serviceAreas || "",
    // Whether the handyman is currently taking new requests (toggle in their dashboard).
    available: true,
    // Private token: a backup way into the handyman's own job dashboard.
    manageToken: crypto.randomBytes(16).toString("hex"),
    stripeAccountId: fields.stripeAccountId || null,
    payoutsEnabled: false,
    detailsSubmitted: false,
  };
  data.handymen.push(handyman);
  write(data);
  return handyman;
}

export function updateHandyman(handymanId, updates) {
  const data = read();
  const idx = data.handymen.findIndex((h) => h.id === handymanId);
  if (idx === -1) return null;
  data.handymen[idx] = { ...data.handymen[idx], ...updates };
  write(data);
  return data.handymen[idx];
}

export function deleteHandyman(handymanId) {
  const data = read();
  const before = data.handymen.length;
  data.handymen = data.handymen.filter((h) => h.id !== handymanId);
  const removed = data.handymen.length !== before;
  if (removed) write(data);
  return removed;
}

// --- Jobs -----------------------------------------------------------------

export function createJob(fields) {
  const data = read();
  const job = {
    id: id("job"),
    createdAt: Date.now(),
    // Escrow lifecycle:
    // pending  -> customer hasn't paid yet
    // paid     -> customer paid; funds HELD by the platform; awaiting handyman accept/decline
    // accepted -> handyman accepted the job; work in progress; funds still held
    // declined -> handyman declined; customer fully refunded
    // work_done-> handyman marked the work finished; awaiting customer confirmation
    // completed-> customer released payment; handyman payout transferred
    status: "pending",
    handymanId: fields.handymanId,
    handymanName: fields.handymanName,
    // Links the booking to a customer account when they're signed in (optional).
    customerUserId: fields.customerUserId || null,
    customerName: fields.customerName || "",
    customerEmail: fields.customerEmail || "",
    customerPhone: fields.customerPhone || "",
    service: fields.service || "",
    description: fields.description || "",
    scheduledFor: fields.scheduledFor || "",
    jobAmountCents: fields.jobAmountCents,
    bookingFeeCents: fields.bookingFeeCents,
    commissionCents: fields.commissionCents,
    platformTotalCents: fields.platformTotalCents,
    handymanPayoutCents: fields.handymanPayoutCents,
    totalChargedCents: fields.totalChargedCents,
    estimatedHours: fields.estimatedHours || null,
    hourlyRateSnapshot: fields.hourlyRateSnapshot || null,
    stripeSessionId: fields.stripeSessionId || null,
    stripePaymentIntentId: null,
    stripeChargeId: null, // used to release the held funds to the handyman
    stripeTransferId: null,
    stripeRefundId: null, // set when a declined booking is refunded
    acceptedAt: null,
    declinedAt: null,
    workDoneAt: null,
    releasedAt: null,
    // Private token: the customer's key to manage this booking (release + review).
    reviewToken: crypto.randomBytes(16).toString("hex"),
    rating: null, // 1-5 once reviewed
    reviewNote: "",
    reviewedAt: null,
  };
  data.jobs.push(job);
  write(data);
  return job;
}

export function getJob(jobId) {
  return read().jobs.find((j) => j.id === jobId) || null;
}

export function getJobBySession(sessionId) {
  return read().jobs.find((j) => j.stripeSessionId === sessionId) || null;
}

export function updateJob(jobId, updates) {
  const data = read();
  const idx = data.jobs.findIndex((j) => j.id === jobId);
  if (idx === -1) return null;
  data.jobs[idx] = { ...data.jobs[idx], ...updates };
  write(data);
  return data.jobs[idx];
}

export function listJobs() {
  return read().jobs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export function listJobsForHandyman(handymanId) {
  return read()
    .jobs.filter((j) => j.handymanId === handymanId)
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export function handymanRating(handymanId) {
  const rated = read().jobs.filter(
    (j) => j.handymanId === handymanId && typeof j.rating === "number"
  );
  if (!rated.length) return { average: null, count: 0 };
  const sum = rated.reduce((s, j) => s + j.rating, 0);
  return { average: Math.round((sum / rated.length) * 10) / 10, count: rated.length };
}

export function listJobsForCustomer({ userId, email }) {
  const em = (email || "").toLowerCase();
  return read()
    .jobs.filter(
      (j) =>
        j.status !== "pending" &&
        ((userId && j.customerUserId === userId) ||
          (em && (j.customerEmail || "").toLowerCase() === em))
    )
    .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

// --- Users (accounts) -----------------------------------------------------

export function getUserById(userId) {
  return read().users.find((u) => u.id === userId) || null;
}

export function getUserByEmail(email) {
  const em = (email || "").toLowerCase();
  return read().users.find((u) => (u.email || "").toLowerCase() === em) || null;
}

export function getUserByProvider(provider, providerId) {
  return (
    read().users.find(
      (u) => u.provider === provider && u.providerId === providerId
    ) || null
  );
}

export function createUser(fields) {
  const data = read();
  const user = {
    id: id("usr"),
    createdAt: Date.now(),
    role: fields.role || "customer", // "customer" | "handyman"
    email: (fields.email || "").toLowerCase(),
    name: fields.name || "",
    phone: fields.phone || "",
    // Auth: either a password hash or a social provider identity.
    provider: fields.provider || "password", // "password" | "google" | "apple"
    providerId: fields.providerId || null,
    passwordHash: fields.passwordHash || null,
    photoUrl: fields.photoUrl || null,
    // Handyman link (if this account owns a handyman profile).
    handymanId: fields.handymanId || null,
    // Customer profile extras.
    zip: fields.zip || "",
    preferredContact: fields.preferredContact || "",
    referral: fields.referral || "",
  };
  data.users.push(user);
  write(data);
  return user;
}

export function updateUser(userId, updates) {
  const data = read();
  const idx = data.users.findIndex((u) => u.id === userId);
  if (idx === -1) return null;
  data.users[idx] = { ...data.users[idx], ...updates };
  write(data);
  return data.users[idx];
}

// Removes a user account and any sessions tied to it (used on account deletion).
export function deleteUser(userId) {
  const data = read();
  const before = data.users.length;
  data.users = data.users.filter((u) => u.id !== userId);
  data.sessions = data.sessions.filter((s) => s.userId !== userId);
  const removed = data.users.length !== before;
  write(data);
  return removed;
}

// --- Sessions -------------------------------------------------------------

export function createSession(userId, ttlMs = 30 * 24 * 60 * 60 * 1000) {
  const data = read();
  const session = {
    token: crypto.randomBytes(32).toString("hex"),
    userId,
    createdAt: Date.now(),
    expiresAt: Date.now() + ttlMs,
  };
  data.sessions.push(session);
  write(data);
  return session;
}

export function getSessionUser(token) {
  if (!token) return null;
  const data = read();
  const session = data.sessions.find((s) => s.token === token);
  if (!session) return null;
  if (session.expiresAt && session.expiresAt < Date.now()) return null;
  return data.users.find((u) => u.id === session.userId) || null;
}

export function deleteSession(token) {
  const data = read();
  const before = data.sessions.length;
  data.sessions = data.sessions.filter((s) => s.token !== token);
  if (data.sessions.length !== before) write(data);
}

// --- Custom job requests ("Describe your job" leads) ----------------------

export function createRequest(fields) {
  const data = read();
  const request = {
    id: id("req"),
    createdAt: Date.now(),
    status: "new", // new -> contacted -> closed
    userId: fields.userId || null,
    name: fields.name || "",
    email: fields.email || "",
    phone: fields.phone || "",
    category: fields.category || "",
    description: fields.description || "",
    area: fields.area || "",
    timing: fields.timing || "",
    budget: fields.budget || "",
  };
  data.requests = data.requests || [];
  data.requests.push(request);
  write(data);
  return request;
}

export function listRequests() {
  return (read().requests || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

export function getRequest(requestId) {
  return (read().requests || []).find((r) => r.id === requestId) || null;
}

export function updateRequest(requestId, updates) {
  const data = read();
  data.requests = data.requests || [];
  const idx = data.requests.findIndex((r) => r.id === requestId);
  if (idx === -1) return null;
  data.requests[idx] = { ...data.requests[idx], ...updates };
  write(data);
  return data.requests[idx];
}

// --- Contact form submissions ----------------------------------------------

export function createContact(fields) {
  const data = read();
  const contact = {
    id: id("cnt"),
    createdAt: Date.now(),
    name: fields.name || "",
    email: fields.email || "",
    phone: fields.phone || "",
    subject: fields.subject || "",
    message: fields.message || "",
  };
  data.contacts = data.contacts || [];
  data.contacts.push(contact);
  write(data);
  return contact;
}

export function listContacts() {
  return (read().contacts || []).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}
