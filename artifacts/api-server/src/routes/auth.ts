import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { Router, type Request, type Response, type NextFunction } from "express";

const router = Router();
const COOKIE_NAME = "channelpulse_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const FAILURE_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_FAILURES = 5;
const sessionSecret = process.env.SESSION_SECRET;
const configuredPassword = process.env.CHANNELPULSE_ADMIN_PASSWORD;

if (!sessionSecret || !configuredPassword) {
  throw new Error("Configure the ChannelPulse authentication secrets before starting the API.");
}

const passwordDigest = createHash("sha256").update(configuredPassword).digest();
const secureCookie = process.env.NODE_ENV === "production";
const loginFailures = new Map<string, { count: number; resetAt: number }>();

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function signature(encodedPayload: string): Buffer {
  return createHmac("sha256", sessionSecret!).update(encodedPayload).digest();
}

function hasValidSession(req: Request): boolean {
  const token = req.cookies?.[COOKIE_NAME];
  if (typeof token !== "string" || token.length > 2048) return false;
  const separator = token.lastIndexOf(".");
  if (separator < 1) return false;

  const encodedPayload = token.slice(0, separator);
  const suppliedSignature = Buffer.from(token.slice(separator + 1), "base64url");
  const expectedSignature = signature(encodedPayload);
  if (suppliedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(suppliedSignature, expectedSignature)) return false;

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    return payload?.sub === "admin" && Number.isSafeInteger(payload.exp) && payload.exp > Date.now();
  } catch {
    return false;
  }
}

function createSessionToken(): string {
  const payload = Buffer.from(JSON.stringify({
    sub: "admin",
    exp: Date.now() + SESSION_TTL_MS,
  })).toString("base64url");
  return `${payload}.${signature(payload).toString("base64url")}`;
}

function currentFailureBucket(ip: string, now: number) {
  const current = loginFailures.get(ip);
  if (current && current.resetAt > now) return current;
  const next = { count: 0, resetAt: now + FAILURE_WINDOW_MS };
  loginFailures.set(ip, next);
  return next;
}

function pruneFailureBuckets(now: number) {
  for (const [ip, bucket] of loginFailures) {
    if (bucket.resetAt <= now) loginFailures.delete(ip);
  }
  if (loginFailures.size > 10_000) {
    const oldest = loginFailures.keys().next().value;
    if (oldest) loginFailures.delete(oldest);
  }
}

router.get("/auth/session", (req, res): void => {
  res.setHeader("Cache-Control", "no-store");
  res.json({ authenticated: hasValidSession(req) });
});

router.post("/auth/login", (req, res): void => {
  const now = Date.now();
  pruneFailureBuckets(now);
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const bucket = currentFailureBucket(ip, now);
  if (bucket.count >= MAX_LOGIN_FAILURES) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
    res.status(429).json({ error: "Too many sign-in attempts. Try again later." });
    return;
  }

  const username = typeof req.body?.username === "string" ? req.body.username : "";
  const submittedPassword = typeof req.body?.password === "string" ? req.body.password : "";
  const password = submittedPassword.length <= 256 ? submittedPassword : "";
  const passwordMatches = timingSafeEqual(digest(password), passwordDigest);
  if (username !== "admin" || !passwordMatches) {
    bucket.count++;
    res.status(401).json({ error: "Invalid username or password." });
    return;
  }

  loginFailures.delete(ip);
  res.cookie(COOKIE_NAME, createSessionToken(), {
    httpOnly: true,
    secure: secureCookie,
    sameSite: "strict",
    path: "/",
    maxAge: SESSION_TTL_MS,
  });
  res.setHeader("Cache-Control", "no-store");
  res.json({ authenticated: true });
});

router.post("/auth/logout", (_req, res): void => {
  res.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    secure: secureCookie,
    sameSite: "strict",
    path: "/",
  });
  res.setHeader("Cache-Control", "no-store");
  res.json({ authenticated: false });
});

export function requireAdminSession(req: Request, res: Response, next: NextFunction): void {
  if (!hasValidSession(req)) {
    res.status(401).json({ error: "Sign in to continue." });
    return;
  }
  next();
}

export default router;
