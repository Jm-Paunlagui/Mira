/**
 * @fileoverview The pool registry: pool name → pool config.
 *
 * Empty until createMira() registers its pools; nothing is built in and no
 * environment variable is read. The Oracle adapter looks pools up here by
 * name when it first needs one.
 */

import { POOL_NAME_RE } from "../config/defineConfig";

/** One registry entry, as the Oracle adapter reads it. */
type ConnectionEntry = {
    user?: string;
    password?: string;
    connectString?: string;
    poolMin?: number;
    poolMax?: number;
    poolIncrement?: number;
    queueMax?: number;
    queueTimeout?: number;
    poolTimeout?: number;
    connectTimeout?: number;
    poolPingInterval?: number;
    stmtCacheSize?: number;
};

/** Registered pools by name. Looked up by own key only (see getConnectionConfig). */
const connections: Record<string, ConnectionEntry> = {};

/**
 * Adds a pool to the registry. Used by createMira(); app code should not need it.
 * @throws when the name is not a valid pool name, or is already registered.
 */
function registerConnection(name: string, entry: ConnectionEntry): void {
    if (typeof name !== "string" || !POOL_NAME_RE.test(name)) {
        throw new Error(`Invalid connection name "${String(name).slice(0, 80)}". Use a letter followed by up to 63 letters, digits or _.`);
    }
    if (Object.hasOwn(connections, name)) {
        throw new Error(`Connection "${name}" is already registered by a live createMira() instance. Close that instance first.`);
    }
    connections[name] = { ...entry };
}

/** Removes a pool from the registry. @returns false when `name` was not registered. */
function unregisterConnection(name: string): boolean {
    if (!Object.hasOwn(connections, name)) return false;
    delete connections[name];
    return true;
}

/** The config registered under `name`. @throws for an unknown name. */
function getConnectionConfig(name: string): ConnectionEntry {
    // Own keys only: "constructor" or "toString" must not resolve to Object's members.
    const config = Object.hasOwn(connections, name) ? connections[name] : undefined;
    if (!config) {
        const available = Object.keys(connections).join(", ") || "(none)";
        throw new Error(`Unknown connection "${String(name).slice(0, 80)}". Registered: ${available}`);
    }
    return config;
}

/** Names of the registered pools. */
function getConnectionNames(): string[] {
    return Object.keys(connections);
}

// Default object as well as named exports: the Oracle adapter destructures
// getConnectionConfig from it at load, and the adapter's unit tests add stub
// pools to `connections` directly.
export default { connections, registerConnection, unregisterConnection, getConnectionConfig, getConnectionNames };
export { connections, registerConnection, unregisterConnection, getConnectionConfig, getConnectionNames };
export type { ConnectionEntry };
