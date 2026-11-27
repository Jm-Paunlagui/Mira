/**
 * @fileoverview Connect-string builders for a pool's `connectString`.
 *
 * Easy Connect (`host:port/service`) is enough for most databases. The TNS
 * descriptor is the one Mira 2.x built for its env-driven pools: two
 * addresses, load balancing, a SID, and basic SELECT failover.
 */

import { miraConfigMessages as MSG } from "../shared/messages/miraConfig.messages";

// Each part is checked before it is written into the connect string: a host such as
// "db)(ADDRESS=(HOST=evil)" would otherwise add an address to the descriptor and send
// the credentials to another server. Values are never echoed back (they come from config).
const HOST_RE = /^(?:\[[0-9A-Fa-f:.]+\]|[0-9A-Fa-f:]+:[0-9A-Fa-f:.]*|[A-Za-z0-9](?:[A-Za-z0-9._-]{0,252}))$/;
const SERVICE_RE = /^[A-Za-z0-9_$#][A-Za-z0-9_.$#-]{0,127}$/;

function checkParts(where: string, host: unknown, port: unknown, service: unknown, serviceLabel: string): { host: string; port: number; service: string } {
    const h = typeof host === "string" ? host.trim() : "";
    if (!HOST_RE.test(h)) throw new TypeError(MSG.CONNECT_PART_INVALID(where, "host", "a host name, an IPv4 address or an IPv6 address"));
    const p = typeof port === "number" ? port : typeof port === "string" && /^\s*\d{1,5}\s*$/.test(port) ? Number(port) : NaN;
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new TypeError(MSG.CONNECT_PART_INVALID(where, "port", "a whole number from 1 to 65535"));
    const s = typeof service === "string" ? service.trim() : "";
    if (!SERVICE_RE.test(s)) throw new TypeError(MSG.CONNECT_PART_INVALID(where, serviceLabel, "letters, digits and _ . $ # -"));
    return { host: h, port: p, service: s };
}

/** Easy Connect: `host:port/service`. */
function buildSimpleConnectString(host: unknown, port: unknown, service: unknown): string {
    const c = checkParts("buildSimpleConnectString", host, port, service, "service");
    const h = c.host.includes(":") && !c.host.startsWith("[") ? `[${c.host}]` : c.host;
    return `${h}:${c.port}/${c.service}`;
}

/** TNS descriptor connecting by SID, with LOAD_BALANCE and SELECT failover (180 retries, 5 s apart). */
function buildTNSConnectString(host: unknown, port: unknown, sid: unknown): string {
    const c = checkParts("buildTNSConnectString", host, port, sid, "SID");
    host = c.host.replace(/^\[|\]$/g, "");
    port = c.port;
    sid = c.service;
    return (
        `(DESCRIPTION=` +
        `(ADDRESS=(PROTOCOL=TCP)(HOST=${host})(PORT=${port}))` +
        `(ADDRESS=(PROTOCOL=TCP)(HOST=${host})(PORT=${port}))` +
        `(LOAD_BALANCE=yes)` +
        `(CONNECT_DATA=(SERVER=DEDICATED)(SID=${sid})` +
        `(FAILOVER_MODE=(TYPE=SELECT)(METHOD=BASIC)(RETRIES=180)(DELAY=5))))`
    );
}

export { buildSimpleConnectString, buildTNSConnectString };
