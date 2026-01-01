import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import net from "node:net";

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

async function waitForReady(url, timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not become ready");
}

test("GET /api/healthz returns ok", async () => {
  const port = await getFreePort();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "taskflow-"));

  const child = spawn(process.execPath, ["server.mjs"], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: "ignore",
  });

  try {
    await waitForReady(`http://localhost:${port}/api/healthz`);
    const res = await fetch(`http://localhost:${port}/api/healthz`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
  } finally {
    child.kill();
  }
});

test("POST /api/tasks creates a task", async () => {
  const port = await getFreePort();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "taskflow-"));

  const child = spawn(process.execPath, ["server.mjs"], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: "ignore",
  });

  try {
    await waitForReady(`http://localhost:${port}/api/healthz`);
    const res = await fetch(`http://localhost:${port}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "test task" }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.task?.id);
    assert.equal(body.task.title, "test task");
    assert.equal(body.task.done, false);
  } finally {
    child.kill();
  }
});
