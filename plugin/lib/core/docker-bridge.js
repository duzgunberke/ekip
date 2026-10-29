// Linux only: containers reach the host at host.docker.internal (host-gateway = the docker0 address),
// but freellmapi listens on 127.0.0.1 so it is never exposed to the network. This forwards
// <docker0 address>:<port> to 127.0.0.1:<port>: reachable from containers, not from the LAN.
//   node docker-bridge.js <listen address> <port>
import net from "node:net";

const [host, port] = [process.argv[2], Number(process.argv[3])];
net.createServer((client) => {
  const up = net.connect(port, "127.0.0.1");
  client.pipe(up).pipe(client);
  const close = () => { client.destroy(); up.destroy(); };
  client.on("error", close); up.on("error", close);
}).on("error", (e) => { console.error(`docker-bridge: ${e.message}`); process.exit(e.code === "EADDRINUSE" ? 0 : 1); })
  .listen(port, host);
