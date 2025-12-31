import http from "node:http";
import { readFile, stat, mkdir, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const PUBLIC_DIR = path.join(__dirname, "public");

const DATA_DIR = path.join(__dirname, "data");
const TASKS_FILE = path.join(DATA_DIR, "tasks.json");

// tasks
let tasks = [];

// --- persistence ---
async function loadTasks() {
  try {
    await mkdir(DATA_DIR, { recursive: true });
    const s = await readFile(TASKS_FILE, "utf8");
    const obj = JSON.parse(s);
    if (Array.isArray(obj)) return obj;
    return [];
  } catch {
    return [];
  }
}

async function saveTasks(nextTasks) {
  await mkdir(DATA_DIR, { recursive: true });
  const tmp = TASKS_FILE + ".tmp";
  await writeFile(tmp, JSON.stringify(nextTasks, null, 2), "utf8");
  await rename(tmp, TASKS_FILE);
}

// 起動時に読み込み
tasks = await loadTasks();

function json(res, status, obj) {
  const body = status === 204 ? "" : JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".json": "application/json; charset=utf-8",
      ".png": "image/png",
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".svg": "image/svg+xml",
    }[ext] || "application/octet-stream"
  );
}

async function readJsonBody(req, limitBytes = 1024 * 1024) {
  return await new Promise((resolve, reject) => {
    let size = 0;
    let data = "";
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      data += chunk.toString("utf8");
    });
    req.on("end", () => {
      if (!data) return resolve(null);
      try {
        resolve(JSON.parse(data));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function notFound(res) {
  sendText(res, 404, "Not Found");
}

const server = http.createServer(async (req, res) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const method = req.method ?? "GET";
  const pathname = url.pathname;

  if (pathname === "/api/healthz" && method === "GET") {
    return json(res, 200, { ok: true, node: process.version, tasks: tasks.length });
  }

  if (pathname === "/api/tasks" && method === "GET") {
    return json(res, 200, { tasks });
  }

  if (pathname === "/api/tasks" && method === "POST") {
    try {
      const body = await readJsonBody(req);
      const title = body?.title;
      if (typeof title !== "string" || title.trim().length === 0) {
        return json(res, 400, { error: "title is required" });
      }
      const task = {
        id: randomUUID(),
        title: title.trim(),
        done: false,
        createdAt: new Date().toISOString(),
      };
      tasks = [task, ...tasks];
      await saveTasks(tasks);
      return json(res, 201, { task });
    } catch (e) {
      return json(res, 400, { error: e.message });
    }
  }

  const m = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (m) {
    const id = m[1];

    if (method === "PATCH") {
      try {
        const body = await readJsonBody(req);
        if (typeof body?.done !== "boolean") {
          return json(res, 400, { error: "done(boolean) is required" });
        }
        const idx = tasks.findIndex((t) => t.id === id);
        if (idx === -1) return json(res, 404, { error: "not found" });

        tasks[idx] = { ...tasks[idx], done: body.done };
        await saveTasks(tasks);
        return json(res, 200, { task: tasks[idx] });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }

    if (method === "DELETE") {
      const before = tasks.length;
      tasks = tasks.filter((t) => t.id !== id);
      if (tasks.length === before) return json(res, 404, { error: "not found" });
      await saveTasks(tasks);
      return json(res, 204, {});
    }

    return json(res, 405, { error: "Method Not Allowed" });
  }

  // static
  let filePath = pathname === "/" ? "/index.html" : pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, "");
  const absPath = path.join(PUBLIC_DIR, filePath);

  try {
    const st = await stat(absPath);
    if (!st.isFile()) return notFound(res);

    const data = await readFile(absPath);
    res.writeHead(200, { "Content-Type": contentType(absPath) });
    res.end(data);
  } catch {
    notFound(res);
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`http://localhost:${PORT}`);
});
