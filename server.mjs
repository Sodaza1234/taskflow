// @ts-check
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { openDb } from "./db.mjs";
import { newId, makePassword, hashPassword, safeEqualHex } from "./auth.mjs";

const PORT = Number(process.env.PORT ?? 3000);
const HOST = process.env.HOST ?? "127.0.0.1";

const DB_PATH =
  process.env.TASKFLOW_DB_PATH ?? path.join(process.cwd(), "data", "taskflow.db");
const db = openDb(DB_PATH);

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {unknown} obj
 */
function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {number} status
 * @param {string} text
 */
function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

/** @param {import("node:http").ServerResponse} res */
function notFound(res) {
  sendText(res, 404, "not found");
}

/** @param {import("node:http").ServerResponse} res */
function unauthorized(res) {
  json(res, 401, { error: "unauthorized" });
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @param {number} [limitBytes]
 */
async function readJsonBody(req, limitBytes = 1024 * 1024) {
  /** @type {Buffer[]} */
  const chunks = [];
  let total = 0;

  await new Promise((resolve, reject) => {
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > limitBytes) {
        reject(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", resolve);
    req.on("error", reject);
  });

  const raw = Buffer.concat(chunks).toString("utf-8").trim();
  if (!raw) return null;
  return JSON.parse(raw);
}

/**
 * @param {string | undefined} cookieHeader
 * @returns {Record<string, string>}
 */
function parseCookies(cookieHeader) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!cookieHeader) return out;
  const parts = cookieHeader.split(";");
  for (const p of parts) {
    const [k, ...rest] = p.trim().split("=");
    if (!k) continue;
    out[k] = rest.join("=");
  }
  return out;
}

/**
 * @param {import("node:http").ServerResponse} res
 * @param {string} name
 * @param {string} value
 * @param {{ httpOnly?: boolean, maxAge?: number, sameSite?: "Lax" | "Strict" | "None", path?: string }} [opts]
 */
function setCookie(res, name, value, opts = {}) {
  const parts = [];
  parts.push(`${name}=${value}`);
  parts.push(`Path=${opts.path ?? "/"}`);
  parts.push(`SameSite=${opts.sameSite ?? "Lax"}`);
  if (opts.httpOnly ?? true) parts.push("HttpOnly");
  if (typeof opts.maxAge === "number") parts.push(`Max-Age=${opts.maxAge}`);
  // NOTE: production HTTPSなら Secure を付ける（今回はローカル想定なので付けない）
  res.setHeader("Set-Cookie", parts.join("; "));
}

/** @returns {string} */
function nowIso() {
  return new Date().toISOString();
}

/**
 * @param {number} days
 * @returns {string}
 */
function addDaysIso(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

/**
 * @param {import("node:http").IncomingMessage} req
 * @returns {{ userId: string, sid: string } | null}
 */
function getAuth(req) {
  const cookies = parseCookies(req.headers.cookie);
  const sid = cookies.sid;
  if (!sid) return null;

  const session = db.getSession(sid);
  if (!session) return null;

  const exp = Date.parse(session.expiresAt);
  if (!Number.isFinite(exp) || exp <= Date.now()) {
    db.deleteSession(sid);
    return null;
  }

  return { userId: session.userId, sid };
}

/** @param {string} filePath */
function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".svg") return "image/svg+xml";
  return "application/octet-stream";
}

const publicDir = path.join(process.cwd(), "public");

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url ?? "/", `http://${HOST}:${PORT}`);
    const pathname = u.pathname;

    // ---- API ----
    if (pathname === "/api/healthz" && req.method === "GET") {
      return json(res, 200, { ok: true, node: process.version });
    }

    if (pathname === "/api/signup" && req.method === "POST") {
      const body = await readJsonBody(req);
      const email = body?.email;
      const password = body?.password;

      if (typeof email !== "string" || email.trim() === "") {
        return json(res, 400, { error: "email is required" });
      }
      if (typeof password !== "string" || password.length < 8) {
        return json(res, 400, { error: "password must be at least 8 chars" });
      }

      const { salt, passwordHash } = makePassword(password);
      const user = {
        id: newId(),
        email: email.trim().toLowerCase(),
        passwordHash,
        salt,
        createdAt: nowIso(),
      };

      try {
        db.createUser(user);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("UNIQUE") && msg.includes("users.email")) {
          return json(res, 409, { error: "email already exists" });
        }
        return json(res, 500, { error: "failed to create user" });
      }

      // signup時にログイン状態にする（最小運用）
      const sid = crypto.randomUUID();
      db.createSession({
        id: sid,
        userId: user.id,
        createdAt: nowIso(),
        expiresAt: addDaysIso(7),
      });
      setCookie(res, "sid", sid, { httpOnly: true, sameSite: "Lax", path: "/" });

      return json(res, 201, { user: { id: user.id, email: user.email, createdAt: user.createdAt } });
    }

    if (pathname === "/api/login" && req.method === "POST") {
      const body = await readJsonBody(req);
      const email = body?.email;
      const password = body?.password;

      if (typeof email !== "string" || email.trim() === "") {
        return json(res, 400, { error: "email is required" });
      }
      if (typeof password !== "string" || password === "") {
        return json(res, 400, { error: "password is required" });
      }

      const user = db.getUserByEmail(email.trim().toLowerCase());
      if (!user) return json(res, 401, { error: "invalid credentials" });

      const computed = hashPassword(password, user.salt);
      if (!safeEqualHex(computed, user.passwordHash)) {
        return json(res, 401, { error: "invalid credentials" });
      }

      const sid = crypto.randomUUID();
      db.createSession({
        id: sid,
        userId: user.id,
        createdAt: nowIso(),
        expiresAt: addDaysIso(7),
      });
      setCookie(res, "sid", sid, { httpOnly: true, sameSite: "Lax", path: "/" });

      return json(res, 200, { ok: true });
    }

    if (pathname === "/api/logout" && req.method === "POST") {
      const cookies = parseCookies(req.headers.cookie);
      const sid = cookies.sid;
      if (sid) db.deleteSession(sid);

      // cookie削除
      setCookie(res, "sid", "", { httpOnly: true, sameSite: "Lax", path: "/", maxAge: 0 });
      res.writeHead(204);
      return res.end();
    }

    if (pathname === "/api/me" && req.method === "GET") {
      const auth = getAuth(req);
      if (!auth) return unauthorized(res);

      const user = db.getUserPublicById(auth.userId);
      if (!user) return unauthorized(res);

      return json(res, 200, { user });
    }

    // tasks: require auth
    if (pathname === "/api/tasks" && req.method === "GET") {
      const auth = getAuth(req);
      if (!auth) return unauthorized(res);

      const tasks = db.listTasksByUser(auth.userId);
      return json(res, 200, { tasks });
    }

    if (pathname === "/api/tasks" && req.method === "POST") {
      const auth = getAuth(req);
      if (!auth) return unauthorized(res);

      const body = await readJsonBody(req);
      const title = body?.title;

      if (typeof title !== "string" || title.trim() === "") {
        return json(res, 400, { error: "title is required" });
      }

      const task = {
        id: crypto.randomUUID(),
        userId: auth.userId,
        title: title.trim(),
        done: false,
        createdAt: nowIso(),
      };

      db.insertTask(task);
      return json(res, 201, { task });
    }

    const m = pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (m && req.method === "PATCH") {
      const auth = getAuth(req);
      if (!auth) return unauthorized(res);

      const id = m[1];
      const body = await readJsonBody(req);
      const done = body?.done;

      if (typeof done !== "boolean") {
        return json(res, 400, { error: "done(boolean) is required" });
      }

      const updated = db.setDone(auth.userId, id, done);
      if (!updated) return notFound(res);

      return json(res, 200, { task: updated });
    }

    if (m && req.method === "DELETE") {
      const auth = getAuth(req);
      if (!auth) return unauthorized(res);

      const id = m[1];
      const ok = db.deleteTask(auth.userId, id);
      if (!ok) return notFound(res);

      res.writeHead(204);
      return res.end();
    }

    // ---- Static ----
    const rel = pathname === "/" ? "/index.html" : pathname;
    const filePath = path.join(publicDir, path.normalize(rel));

    if (!filePath.startsWith(publicDir)) return notFound(res);

    fs.readFile(filePath, (err, buf) => {
      if (err) return notFound(res);
      res.writeHead(200, { "content-type": contentType(filePath) });
      res.end(buf);
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return json(res, 500, { error: msg });
  }
});

server.listen(PORT, HOST, () => {
  // eslint-disable-next-line no-console
  console.log(`http://localhost:${PORT}`);
});
