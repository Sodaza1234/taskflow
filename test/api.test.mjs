// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdtemp } from "node:fs/promises";

function getFreePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (!addr || typeof addr === "string") {
        s.close(() => reject(new Error("failed to get port")));
        return;
      }
      const port = addr.port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

/**
 * @param {string} url
 * @param {number} [timeoutMs]
 */
async function waitForReady(url, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not become ready");
}

async function startServer() {
  const port = await getFreePort();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "taskflow-"));
  const dbPath = path.join(dataDir, "taskflow.db");

  const child = spawn(process.execPath, ["server.mjs"], {
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      TASKFLOW_DB_PATH: dbPath,
    },
    stdio: "ignore",
  });

  const base = `http://127.0.0.1:${port}`;
  await waitForReady(`${base}/api/healthz`);

  return {
    base,
    child,
    stop: () => {
      child.kill();
    },
  };
}

/** @param {string} base */
async function signupAndGetCookie(base) {
  const email = `user_${Date.now()}@example.com`;
  const password = "password123";

  const r = await fetch(`${base}/api/signup`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  assert.equal(r.status, 201);

  const setCookie = r.headers.get("set-cookie");
  assert.ok(setCookie, "missing set-cookie");

  const cookie = setCookie.split(";")[0]; // sid=...
  return cookie;
}

test("GET /api/healthz returns ok", async () => {
  const s = await startServer();
  try {
    const r = await fetch(`${s.base}/api/healthz`);
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(j.ok, true);
  } finally {
    s.stop();
  }
});

test("POST /api/tasks creates a task (requires auth cookie)", async () => {
  const s = await startServer();
  try {
    const cookie = await signupAndGetCookie(s.base);

    const create = await fetch(`${s.base}/api/tasks`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({ title: "hello" }),
    });

    assert.equal(create.status, 201);
    const created = await create.json();
    assert.equal(created.task.title, "hello");

    const list = await fetch(`${s.base}/api/tasks`, {
      headers: { cookie },
    });
    assert.equal(list.status, 200);
    const listed = await list.json();
    assert.ok(Array.isArray(listed.tasks));
    assert.ok(listed.tasks.some((/** @type {{ title: string }} */ t) => t.title === "hello"));
  } finally {
    s.stop();
  }
});
