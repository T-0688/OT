/**
 * M1 探针：直接跑 omp acp，验证协议握手与事件流。
 * 用法：node probe.mjs ["你的 prompt"]
 */
import { spawn } from "node:child_process";
import * as acp from "@agentclientprotocol/sdk";

const OMP = process.env.OMP_BIN ?? "omp";
const CWD = process.env.OMP_CWD ?? process.cwd();
const PROMPT = process.argv[2] ?? null;

const child = spawn(OMP, ["acp"], {
  cwd: CWD,
  stdio: ["pipe", "pipe", "pipe"],
  env: { ...process.env, NO_COLOR: "1" },
});

child.stderr.on("data", (d) => process.stderr.write(`[omp:stderr] ${d}`));
child.on("exit", (code, sig) => console.log(`\n[probe] omp exited code=${code} sig=${sig}`));

const output = new WritableStream({
  write(chunk) {
    child.stdin.write(chunk);
  },
});
const input = new ReadableStream({
  start(controller) {
    child.stdout.on("data", (d) => controller.enqueue(new Uint8Array(d)));
    child.on("close", () => {
      try {
        controller.close();
      } catch {}
    });
  },
});
const stream = acp.ndJsonStream(output, input);

let seen = 0;
const counts = new Map();

const app = acp
  .client({ name: "omp-desktop-probe", version: "0.1.0" })
  .onNotification("session/update", ({ params }) => {
    const u = params?.update ?? {};
    const kind = u.sessionUpdate ?? "unknown";
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    seen++;
    if (kind.endsWith("_chunk")) {
      const text = u.content?.text ?? "";
      process.stdout.write(text);
    } else {
      console.log(`\n[update:${kind}] ${JSON.stringify(u).slice(0, 600)}`);
    }
  })
  .onRequest("session/request_permission", ({ params }) => {
    const opts = params?.options ?? [];
    console.log(
      `\n[permission] ${params?.toolCall?.title ?? "?"} options=${opts.map((o) => `${o.kind}:${o.optionId}`).join(",")}`,
    );
    const pick = opts.find((o) => o.kind === "allow_once") ?? opts.find((o) => o.kind === "allow_always") ?? opts[0];
    return pick
      ? { outcome: { outcome: "selected", optionId: pick.optionId } }
      : { outcome: { outcome: "cancelled" } };
  })
  .onRequest("fs/read_text_file", ({ params }) => {
    console.log(`\n[fs/read] ${params?.path}`);
    throw new Error("probe does not implement fs/read_text_file");
  })
  .onRequest("fs/write_text_file", ({ params }) => {
    console.log(`\n[fs/write] ${params?.path}`);
    throw new Error("probe does not implement fs/write_text_file");
  });

try {
  await app.connectWith(stream, async (ctx) => {
    const init = await ctx.request("initialize", {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "omp-desktop-probe", version: "0.1.0" },
    });
    console.log("[probe] protocolVersion =", init.protocolVersion);
    console.log("[probe] agentCapabilities =", JSON.stringify(init.agentCapabilities ?? {}, null, 2));
    console.log("[probe] authMethods =", JSON.stringify(init.authMethods ?? []));

    const session = await ctx.request("session/new", { cwd: CWD, mcpServers: [] });
    console.log("[probe] sessionId =", session.sessionId);
    console.log("[probe] session payload =", JSON.stringify(session).slice(0, 800));

    if (PROMPT) {
      console.log(`\n[probe] >>> prompt: ${PROMPT}\n`);
      const res = await ctx.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: PROMPT }],
      });
      console.log("\n[probe] prompt result =", JSON.stringify(res));
    }
  });
} catch (err) {
  console.error("[probe] FAILED:", err);
  process.exitCode = 1;
} finally {
  console.log("[probe] update counts =", Object.fromEntries(counts), "total =", seen);
  try {
    child.stdin.end();
  } catch {}
  setTimeout(() => child.kill(), 500);
}
