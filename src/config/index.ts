/**
 * Config entry point — Adapter factory.
 *
 * All app code imports from here:
 *   const db = require('./config');
 *   await db.withConnection('appDb', async (conn) => { ... });
 *
 * The pool name must be one of the REGISTERED pools (see POOL_NAMES in
 * ./database.js). Always pass a hardcoded literal, never a request-derived
 * value (CWE-89 pool forgery).
 *
 * To add a new DB engine:
 *   1. Create src/config/adapters/<engine>.js
 *   2. Add a case in _loadAdapter()
 *   3. Set DB_TYPE=<engine> in .env
 */



function _loadAdapter(engine: string) {
  switch (engine.toLowerCase()) {
    case "oracle":
      return (require("./adapters/oracle") as typeof import("./adapters/oracle"));

    // case 'postgres': return require('./adapters/postgres');
    // case 'mssql':    return require('./adapters/mssql');

    default:
      throw new Error(
        `Unknown DB_TYPE "${engine}". ` +
          `Supported: oracle. Add a new adapter in src/config/adapters/ to extend.`,
      );
  }
}

/**
 * Build the adapter for the current environment.
 * Resolution order: argument → DB_TYPE env var → 'oracle'
 * @param {string} [engine]
 */
function createAdapter(engine?: string) {
  return _loadAdapter((engine || process.env.DB_TYPE || "oracle").trim());
}

const _default = createAdapter();

export default {
  ..._default,
  createAdapter,
  ...(require("./database") as typeof import("./database")),
};
