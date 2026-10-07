// Thin wrapper over the D1 binding so query sites read cleanly.
// Works against the real env.DB and against the local node:sqlite shim,
// both of which expose prepare().bind().first()/all()/run().

export function db(env) {
  const DB = env.DB;
  return {
    async get(sql, ...args) {
      return DB.prepare(sql).bind(...args).first();
    },
    async all(sql, ...args) {
      const r = await DB.prepare(sql).bind(...args).all();
      return r.results || [];
    },
    async run(sql, ...args) {
      return DB.prepare(sql).bind(...args).run();
    },
  };
}
