"use strict";

const dotenv = require("dotenv");
dotenv.config({ path: ".env" });

const isDevelopment = process.env.NODE_ENV === "development";

function buildSimpleConnectString(host, port, service) {
    return `${host}:${port}/${service}`;
}

function buildTNSConnectString(host, port, sid) {
    return (
        `(DESCRIPTION=` +
        `(ADDRESS=(PROTOCOL=TCP)(HOST=${host})(PORT=${port}))` +
        `(ADDRESS=(PROTOCOL=TCP)(HOST=${host})(PORT=${port}))` +
        `(LOAD_BALANCE=yes)` +
        `(CONNECT_DATA=(SERVER=DEDICATED)(SID=${sid})` +
        `(FAILOVER_MODE=(TYPE=SELECT)(METHOD=BASIC)(RETRIES=180)(DELAY=5))))`
    );
}

/**
 * Connection registry.
 *
 * HOW TO ADD A NEW CONNECTION:
 *   1. Add env vars to .env
 *   2. Add one entry here
 *   3. Use it: withConnection('yourKey', callback)
 *   — No other file needs to change.
 *
 * Per-entry fields:
 *   user           {string}  Oracle username
 *   password       {string}  Oracle password
 *   connectString  {string}  Oracle connect string
 *   poolMin        {number}  optional — overrides global default
 *   poolMax        {number}  optional — overrides global default
 */
const connections = {
    userAccount: {
        user: process.env.UA_DB_USERNAME,
        password: process.env.UA_DB_PASSWORD,
        connectString: buildSimpleConnectString(
            process.env.DB_HOST,
            process.env.DB_PORT,
            process.env.DB_SERVICE_NAME,
        ),
    },

    // ── Connection Sample for environment-specific configs ──────────────────────────────────────────
    // sampleInventory: isDevelopment
    //     ? {
    //           user: process.env.SI_TEST_DB_USERNAME,
    //           password: process.env.SI_TEST_DB_PASSWORD,
    //           connectString: buildTNSConnectString(
    //               process.env.DB_TEST_HOST,
    //               process.env.DB_TEST_PORT,
    //               process.env.DB_TEST_SID,
    //           ),
    //       }
    //     : {
    //           user: process.env.SI_DB_USERNAME,
    //           password: process.env.SI_DB_PASSWORD,
    //           connectString: buildSimpleConnectString(
    //               process.env.DB_HOST,
    //               process.env.DB_PORT,
    //               process.env.DB_SERVICE_NAME,
    //           ),
    //       },

    // ── Add new connections below ──────────────────────────────────────────
    // reportingDb: {
    //     user:          process.env.RPT_DB_USERNAME,
    //     password:      process.env.RPT_DB_PASSWORD,
    //     connectString: buildSimpleConnectString(
    //         process.env.RPT_DB_HOST,
    //         process.env.RPT_DB_PORT,
    //         process.env.RPT_DB_SERVICE_NAME,
    //     ),
    //     poolMax: 10,
    // },
};

function getConnectionConfig(name) {
    const config = connections[name];
    if (!config) {
        const available = Object.keys(connections).join(", ");
        throw new Error(
            `Unknown connection "${name}". Registered: ${available}`,
        );
    }
    return config;
}

function getConnectionNames() {
    return Object.keys(connections);
}

module.exports = {
    connections,
    getConnectionConfig,
    getConnectionNames,
    isDevelopment,
    buildSimpleConnectString,
    buildTNSConnectString,
};
