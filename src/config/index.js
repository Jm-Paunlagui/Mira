/**
 * Config entry point — Adapter factory.
 *
 * All app code imports from here:
 *   const db = require('./config');
 *   await db.withConnection('unitInventory', async (conn) => { ... });
 *
 * To add a new DB engine:
 *   1. Create src/config/adapters/<engine>.js
 *   2. Add a case in _loadAdapter()
 *   3. Set DB_TYPE=<engine> in .env
 */

'use strict';

function _loadAdapter(engine) {
    switch (engine.toLowerCase()) {
        case 'oracle':
            return require('./adapters/oracle');

        // case 'postgres': return require('./adapters/postgres');
        // case 'mssql':    return require('./adapters/mssql');

        default:
            throw new Error(
                `Unknown DB_TYPE "${engine}". ` +
                `Supported: oracle. Add a new adapter in src/config/adapters/ to extend.`
            );
    }
}

/**
 * Build the adapter for the current environment.
 * Resolution order: argument → DB_TYPE env var → 'oracle'
 * @param {string} [engine]
 */
function createAdapter(engine) {
    return _loadAdapter((engine || process.env.DB_TYPE || 'oracle').trim());
}

const _default = createAdapter();

module.exports = {
    ..._default,
    createAdapter,
    ...require('./database'),
};