import {
  createClient,
  type Client,
  type InValue,
  type Transaction,
} from "@libsql/client";

type Executor = Pick<Client, "execute" | "batch">;
export class SqlStore {
  constructor(private executor: Executor) {}
  query(sql: string) {
    return {
      get: async (...args: InValue[]) =>
        (await this.executor.execute({ sql, args })).rows[0],
      all: async (...args: InValue[]) =>
        (await this.executor.execute({ sql, args })).rows,
      run: async (...args: InValue[]) => this.executor.execute({ sql, args }),
    };
  }
  batch(statements: Array<{ sql: string; args: InValue[] }>) {
    return this.executor.batch(statements, "write");
  }
}
export class Database extends SqlStore {
  constructor(readonly client: Client) {
    super(client);
  }
  async transaction<T>(work: (tx: SqlStore) => Promise<T>): Promise<T> {
    const tx: Transaction = await this.client.transaction("write");
    try {
      const result = await work(new SqlStore(tx));
      await tx.commit();
      return result;
    } catch (error) {
      await tx.rollback().catch(() => {});
      throw error;
    } finally {
      tx.close();
    }
  }
  close() {
    this.client.close();
  }
}
export async function openDatabase(path?: string) {
  const url = path
    ? path === ":memory:"
      ? "file::memory:"
      : path.startsWith("file:")
      ? path
      : `file:${path}`
    : process.env.TURSO_DATABASE_URL ||
      `file:${process.env.DATABASE_PATH ?? "folio.sqlite"}`;
  const remote = !url.startsWith("file:");
  if (remote && !process.env.TURSO_AUTH_TOKEN)
    throw new Error("TURSO_AUTH_TOKEN is required for remote databases");
  const client = createClient({
    url,
    authToken: remote ? process.env.TURSO_AUTH_TOKEN : undefined,
  });
  await client.batch(
    [
      "CREATE TABLE IF NOT EXISTS records (kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(kind,id))",
      "CREATE TABLE IF NOT EXISTS secrets (id TEXT PRIMARY KEY, value TEXT NOT NULL)",
      "CREATE INDEX IF NOT EXISTS records_kind ON records(kind)",
    ],
    "write"
  );
  return new Database(client);
}
