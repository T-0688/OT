import { spawn } from "node:child_process";
import * as acp from "@agentclientprotocol/sdk";
const child = spawn("omp", ["acp"], { stdio: ["pipe","pipe","ignore"], windowsHide: true });
const output = new WritableStream({ write: (c) => child.stdin.write(Buffer.from(c)) });
const input = new ReadableStream({ start(controller) { child.stdout.on("data", (d) => controller.enqueue(new Uint8Array(d))); child.on("close", () => { try { controller.close(); } catch {} }); } });
const stream = acp.ndJsonStream(output, input);
let printed = false;
const app = acp.client({ name: "probe", version: "0" })
  .onNotification("session/update", ({ params }) => {
    const u = params?.update;
    if (u?.sessionUpdate === "available_commands_update" && !printed) {
      printed = true;
      console.log(u.availableCommands.map(c => "/" + c.name + "  " + (c.description ?? "")).join("\n"));
      setTimeout(() => { child.kill(); process.exit(0); }, 300);
    }
  });
await app.connectWith(stream, async (ctx) => {
  await ctx.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  const s = await ctx.request("session/new", { cwd: process.cwd(), mcpServers: [] });
  console.log("mode options:", JSON.stringify(s.configOptions?.find(o => o.id === "mode")?.options ?? []));
  await new Promise(r => setTimeout(r, 4000));
});
child.kill(); process.exit(0);
