/**
 * A TCP proxy between Mira and the test database, for network chaos without
 * database privileges:
 *
 *   const proxy = await startChaosProxy();       // forwards to MIRA_DB_* host:port
 *   pool config: { ...app, connectString: proxy.connectString }
 *   proxy.stall()    // packets stop flowing both ways; sockets stay open (a dropped link)
 *   proxy.resume()   // traffic flows again; buffered bytes are delivered in order
 *   proxy.reset()    // every open connection is cut (what a database restart looks like to a client)
 *   proxy.refuse(on) // new connections are refused / accepted again
 *   await proxy.close()
 *
 * A stall pauses both sockets, so the kernel buffers fill and the sender blocks,
 * like a link that drops packets: nothing errors until a timeout fires.
 */
import net from "node:net";

/** host, port and service (or SID) of MIRA_DB_CONNECT_STRING (Easy Connect or a TNS descriptor). */
export function targetOf(connectString: string): { host: string; port: number; service?: string; sid?: string } {
  const host = /HOST\s*=\s*([^)\s]+)/i.exec(connectString)?.[1];
  const port = /PORT\s*=\s*(\d+)/i.exec(connectString)?.[1];
  if (host && port) {
    const service = /SERVICE_NAME\s*=\s*([^)\s]+)/i.exec(connectString)?.[1];
    const sid = /\bSID\s*=\s*([^)\s]+)/i.exec(connectString)?.[1];
    if (service || sid) return { host, port: Number(port), service, sid };
  }
  const e = /^(?:\/\/)?([^:/\s()]+)(?::(\d+))?\/([^:?\s]+)/.exec(connectString.trim());
  if (e) return { host: e[1], port: Number(e[2] ?? 1521), service: e[3] };
  throw new Error("chaosProxy: cannot read host/port/service from the connect string");
}

/** The same database, reached through 127.0.0.1:port. */
function viaProxy(port: number, t: { service?: string; sid?: string }): string {
  return t.service
    ? `127.0.0.1:${port}/${t.service}`
    : `(DESCRIPTION=(ADDRESS=(PROTOCOL=TCP)(HOST=127.0.0.1)(PORT=${port}))(CONNECT_DATA=(SID=${t.sid})))`;
}

export type ChaosProxy = {
  connectString: string;
  port: number;
  /** Connections currently open through the proxy. */
  readonly open: number;
  stall(): void;
  resume(): void;
  reset(): void;
  refuse(on: boolean): void;
  close(): Promise<void>;
};

export async function startChaosProxy(connectString = process.env.MIRA_DB_CONNECT_STRING ?? ""): Promise<ChaosProxy> {
  const target = targetOf(connectString);
  const pairs = new Set<{ a: net.Socket; b: net.Socket }>();
  let stalled = false;
  let refusing = false;

  const server = net.createServer((client) => {
    if (refusing) return void client.destroy();
    const upstream = net.connect(target.port, target.host);
    const pair = { a: client, b: upstream };
    pairs.add(pair);
    const drop = () => {
      pairs.delete(pair);
      client.destroy();
      upstream.destroy();
    };
    client.on("error", drop).on("close", drop);
    upstream.on("error", drop).on("close", drop);
    client.pipe(upstream);
    upstream.pipe(client);
    if (stalled) {
      client.pause();
      upstream.pause();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as net.AddressInfo).port;

  return {
    connectString: viaProxy(port, target),
    port,
    get open() {
      return pairs.size;
    },
    stall() {
      stalled = true;
      for (const { a, b } of pairs) {
        a.pause();
        b.pause();
      }
    },
    resume() {
      stalled = false;
      for (const { a, b } of pairs) {
        a.resume();
        b.resume();
      }
    },
    reset() {
      for (const { a, b } of [...pairs]) {
        a.destroy();
        b.destroy();
      }
      pairs.clear();
    },
    refuse(on: boolean) {
      refusing = on;
    },
    close() {
      this.reset();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}
