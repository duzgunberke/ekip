import { main } from "./memory/mcp.js";
main().catch((e) => { console.error(e.message); process.exitCode = 1; });
