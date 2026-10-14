import mysql, { type Pool, type PoolConnection } from "mysql2/promise";
import type { Config } from "./config.js";

export type Health = { dependency: string; status: string; lastSuccess: string | null; lastError: string | null };
let pool: Pool | undefined;

export async function initDatabase(config: Config): Promise<void> {
  if (pool) await pool.end().catch(() => undefined);
  pool = mysql.createPool({ ...config.mysql, waitForConnections: true, connectionLimit: 5, timezone: "Z", decimalNumbers: false });
  try {
    await pool.query("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1");
  } catch (error) {
    await pool.end();
    pool = undefined;
    throw new Error("Database schema is not migrated; run `npm run db:migrate` first", { cause: error });
  }
}

export async function query<T>(sql: string, values: unknown[] = []): Promise<T> {
  if (!pool) throw new Error("MySQL is not initialized");
  const [rows] = await pool.execute(sql, values as any[]);
  return rows as T;
}
export async function execute(sql: string, values: unknown[] = []): Promise<mysql.ResultSetHeader> {
  if (!pool) throw new Error("MySQL is not initialized");
  const [result] = await pool.execute<mysql.ResultSetHeader>(sql, values as any[]);
  return result;
}
export async function transaction<T>(work: (connection: PoolConnection) => Promise<T>): Promise<T> {
  if (!pool) throw new Error("MySQL is not initialized");
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const result = await work(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback().catch(() => undefined);
    throw error;
  } finally {
    connection.release();
  }
}
export async function withNamedLock<T>(name: string, work: () => Promise<T>): Promise<T | null> {
  if (!pool) throw new Error("MySQL is not initialized");
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.execute("SELECT GET_LOCK(?, 0) acquired", [name]);
    if ((rows as Array<{ acquired: number }>)[0]?.acquired !== 1) return null;
    try { return await work(); }
    finally { await connection.execute("SELECT RELEASE_LOCK(?)", [name]).catch(() => undefined); }
  } finally { connection.release(); }
}
export async function closeDatabase(): Promise<void> { await pool?.end(); pool = undefined; }
