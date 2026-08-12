// Authentication helpers: password hashing, session cookies, and verification
// of Google / Apple sign-in ID tokens. Kept dependency-light: passwords use
// Node's built-in scrypt, and social ID tokens are verified with `jose`.

import crypto from "crypto";
import { jwtVerify, createRemoteJWKSet } from "jose";
import * as db from "./db.js";

const COOKIE_NAME = "sid";
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days

// --- Passwords ------------------------------------------------------------

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(":")) return false;
  const [salt, hash] = stored.split(":");
  const test = crypto.scryptSync(password, salt, 64).toString("hex");
  const a = Buffer.from(hash, "hex");
  const b = Buffer.from(test, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// --- Cookies / sessions ---------------------------------------------------

export function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > -1) {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return out;
}

export function setSessionCookie(res, token, { secure = false } = {}) {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${SESSION_TTL_SECONDS}`,
  ];
  if (secure) parts.push("Secure");
  res.append("Set-Cookie", parts.join("; "));
}

export function clearSessionCookie(res) {
  res.append(
    "Set-Cookie",
    `${COOKIE_NAME}=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax`
  );
}

// Returns the logged-in user for this request, or null.
export function getCurrentUser(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  return db.getSessionUser(token);
}

export function getSessionToken(req) {
  return parseCookies(req)[COOKIE_NAME] || null;
}

// --- Social sign-in verification -----------------------------------------

const googleJWKS = createRemoteJWKSet(
  new URL("https://www.googleapis.com/oauth2/v3/certs")
);
const appleJWKS = createRemoteJWKSet(
  new URL("https://appleid.apple.com/auth/keys")
);

// Verifies a Google Identity Services credential (an ID token / JWT).
export async function verifyGoogleIdToken(idToken, clientId) {
  const { payload } = await jwtVerify(idToken, googleJWKS, {
    issuer: ["https://accounts.google.com", "accounts.google.com"],
    audience: clientId,
  });
  return {
    providerId: payload.sub,
    email: payload.email,
    emailVerified: !!payload.email_verified,
    name: payload.name || "",
    photoUrl: payload.picture || null,
  };
}

// Verifies a Sign in with Apple identity token (JWT).
export async function verifyAppleIdToken(idToken, clientId) {
  const { payload } = await jwtVerify(idToken, appleJWKS, {
    issuer: "https://appleid.apple.com",
    audience: clientId,
  });
  return {
    providerId: payload.sub,
    email: payload.email || "",
    emailVerified: payload.email_verified === true || payload.email_verified === "true",
    name: "",
    photoUrl: null,
  };
}

// A safe, public-facing view of a user (never leak the password hash).
export function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    role: u.role,
    email: u.email,
    name: u.name,
    phone: u.phone || "",
    photoUrl: u.photoUrl || null,
    handymanId: u.handymanId || null,
    provider: u.provider,
  };
}
