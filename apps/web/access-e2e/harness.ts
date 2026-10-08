// A local stand-in for the internet: an HTTP proxy that tunnels every host (CONNECT)
// to one HTTPS recording server, so the real fixtures can be driven against the real
// Dev Pages host name, look-alikes, and redirect targets without leaving the machine.
// Records, per request, the Host and whether Access headers arrived. Dummy values only.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { connect, type AddressInfo, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Seen {
  readonly scheme: "http" | "https";
  readonly host: string;
  readonly path: string;
  readonly id?: string;
  readonly secret?: string;
}

export interface Harness {
  readonly proxyUrl: string;
  readonly seen: Seen[];
  close(): Promise<void>;
}

function respond(scheme: Seen["scheme"], seen: Seen[]) {
  return (request: IncomingMessage, response: ServerResponse) => {
    const url = new URL(request.url ?? "/", `${scheme}://${request.headers.host ?? "unknown"}`);
    const id = request.headers["cf-access-client-id"];
    const secret = request.headers["cf-access-client-secret"];
    seen.push({
      scheme,
      host: url.hostname,
      path: url.pathname,
      ...(typeof id === "string" ? { id } : {}),
      ...(typeof secret === "string" ? { secret } : {}),
    });
    // Stand-ins for Access in front of a host: a login redirect, and a bare 403 for a bad token.
    if (url.hostname.startsWith("challenged.")) {
      response.writeHead(302, { location: "https://unknowntpo.cloudflareaccess.com/cdn-cgi/access/login/x" }).end();
      return;
    }
    if (url.hostname.startsWith("rejected.")) {
      response.writeHead(403, { "content-type": "text/plain" }).end("Forbidden");
      return;
    }
    const to = url.searchParams.get("to");
    if (url.pathname === "/redirect" && to !== null) {
      response.writeHead(302, { location: to }).end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>harness</title><p>ok</p>");
  };
}

export async function startHarness(port: number): Promise<Harness> {
  const seen: Seen[] = [];
  const dir = mkdtempSync(join(tmpdir(), "access-harness-"));
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=access-harness",
    "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
  ], { stdio: "ignore" });
  const https = createHttpsServer(
    { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) },
    respond("https", seen),
  );
  await new Promise<void>((done) => https.listen(0, "127.0.0.1", done));
  const httpsPort = (https.address() as AddressInfo).port;

  const sockets = new Set<Socket>();
  // Plain http:// requests arrive at the proxy in absolute form and are answered directly.
  const proxy = createHttpServer(respond("http", seen));
  proxy.on("connect", (_request, client: Socket, head: Buffer) => {
    const upstream = connect(httpsPort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    for (const socket of [client, upstream]) {
      sockets.add(socket);
      socket.on("error", () => socket.destroy());
      socket.on("close", () => sockets.delete(socket));
    }
  });
  await new Promise<void>((done) => proxy.listen(port, "127.0.0.1", done));

  return {
    proxyUrl: `http://127.0.0.1:${port}`,
    seen,
    async close() {
      for (const socket of sockets) socket.destroy();
      await Promise.all([
        new Promise((done) => proxy.close(done)),
        new Promise((done) => https.close(done)),
      ]);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
