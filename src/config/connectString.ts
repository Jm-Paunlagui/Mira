/**
 * @fileoverview Connect-string builders for a pool's `connectString`.
 *
 * Easy Connect (`host:port/service`) is enough for most databases. The TNS
 * descriptor is the one Mira 2.x built for its env-driven pools: two
 * addresses, load balancing, a SID, and basic SELECT failover.
 */

/** Easy Connect: `host:port/service`. */
function buildSimpleConnectString(host: unknown, port: unknown, service: unknown): string {
    return `${host}:${port}/${service}`;
}

/** TNS descriptor connecting by SID, with LOAD_BALANCE and SELECT failover (180 retries, 5 s apart). */
function buildTNSConnectString(host: unknown, port: unknown, sid: unknown): string {
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
