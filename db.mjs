// @ts-check
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** @typedef {{ id: string, email: string, passwordHash: string, salt: string, createdAt: string }} UserRow */
/** @typedef {{ id: string, email: string, createdAt: string }} UserPublic */
/** @typedef {{ id: string, userId: string, expiresAt: string, createdAt: string }} SessionRow */
/** @typedef {{ id: string, userId: string, title: string, done: boolean, createdAt: string }} Task */

/** @param {string} filePath */
function ensureDirForFile(filePath) {
  mkdirSync(path.dirname(filePath), { recursive: true });
}

/**
 * @param {string} dbPath
 */
export function openDb(dbPath) {
  ensureDirForFile(dbPath);

  const db = new DatabaseSync(dbPath);

  db.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      passwordHash TEXT NOT NULL,
      salt TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      expiresAt TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      title TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_user_created ON tasks(userId, createdAt DESC);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(userId);
  `);

  // users
  const stmtUserInsert = db.prepare(
    "INSERT INTO users (id, email, passwordHash, salt, createdAt) VALUES (?, ?, ?, ?, ?)"
  );
  const stmtUserByEmail = db.prepare(
    "SELECT id, email, passwordHash, salt, createdAt FROM users WHERE email = ?"
  );
  const stmtUserPublicById = db.prepare(
    "SELECT id, email, createdAt FROM users WHERE id = ?"
  );

  // sessions
  const stmtSessionInsert = db.prepare(
    "INSERT INTO sessions (id, userId, expiresAt, createdAt) VALUES (?, ?, ?, ?)"
  );
  const stmtSessionGet = db.prepare(
    "SELECT id, userId, expiresAt, createdAt FROM sessions WHERE id = ?"
  );
  const stmtSessionDelete = db.prepare("DELETE FROM sessions WHERE id = ?");

  // tasks
  const stmtTasksListByUser = db.prepare(
    "SELECT id, userId, title, done, createdAt FROM tasks WHERE userId = ? ORDER BY createdAt DESC"
  );
  const stmtTaskInsert = db.prepare(
    "INSERT INTO tasks (id, userId, title, done, createdAt) VALUES (?, ?, ?, ?, ?)"
  );
  const stmtTaskGetByIdUser = db.prepare(
    "SELECT id, userId, title, done, createdAt FROM tasks WHERE id = ? AND userId = ?"
  );
  const stmtTaskUpdateDoneByIdUser = db.prepare(
    "UPDATE tasks SET done = ? WHERE id = ? AND userId = ?"
  );
  const stmtTaskDeleteByIdUser = db.prepare(
    "DELETE FROM tasks WHERE id = ? AND userId = ?"
  );

  /** @param {UserRow} u */
  function createUser(u) {
    stmtUserInsert.run(u.id, u.email, u.passwordHash, u.salt, u.createdAt);
  }

  /** @param {string} email @returns {UserRow | null} */
  function getUserByEmail(email) {
    const r = stmtUserByEmail.get(email);
    if (!r) return null;
    return {
      id: String(r.id),
      email: String(r.email),
      passwordHash: String(r.passwordHash),
      salt: String(r.salt),
      createdAt: String(r.createdAt),
    };
  }

  /** @param {string} userId @returns {UserPublic | null} */
  function getUserPublicById(userId) {
    const r = stmtUserPublicById.get(userId);
    if (!r) return null;
    return { id: String(r.id), email: String(r.email), createdAt: String(r.createdAt) };
  }

  /** @param {SessionRow} s */
  function createSession(s) {
    stmtSessionInsert.run(s.id, s.userId, s.expiresAt, s.createdAt);
  }

  /** @param {string} sid @returns {SessionRow | null} */
  function getSession(sid) {
    const r = stmtSessionGet.get(sid);
    if (!r) return null;
    return {
      id: String(r.id),
      userId: String(r.userId),
      expiresAt: String(r.expiresAt),
      createdAt: String(r.createdAt),
    };
  }

  /** @param {string} sid */
  function deleteSession(sid) {
    stmtSessionDelete.run(sid);
  }

  /** @param {string} userId @returns {Task[]} */
  function listTasksByUser(userId) {
    const rows = stmtTasksListByUser.all(userId);
    return rows.map((r) => ({
      id: String(r.id),
      userId: String(r.userId),
      title: String(r.title),
      done: Number(r.done) === 1,
      createdAt: String(r.createdAt),
    }));
  }

  /** @param {Task} t */
  function insertTask(t) {
    stmtTaskInsert.run(t.id, t.userId, t.title, t.done ? 1 : 0, t.createdAt);
  }

  /** @param {string} userId @param {string} id @param {boolean} done @returns {Task | null} */
  function setDone(userId, id, done) {
    const r = stmtTaskUpdateDoneByIdUser.run(done ? 1 : 0, id, userId);
    if (!r || r.changes === 0) return null;

    const row = stmtTaskGetByIdUser.get(id, userId);
    if (!row) return null;

    return {
      id: String(row.id),
      userId: String(row.userId),
      title: String(row.title),
      done: Number(row.done) === 1,
      createdAt: String(row.createdAt),
    };
  }

  /** @param {string} userId @param {string} id @returns {boolean} */
  function deleteTask(userId, id) {
    const r = stmtTaskDeleteByIdUser.run(id, userId);
    return !!r && r.changes > 0;
  }

  return {
    createUser,
    getUserByEmail,
    getUserPublicById,
    createSession,
    getSession,
    deleteSession,
    listTasksByUser,
    insertTask,
    setDone,
    deleteTask,
  };
}
