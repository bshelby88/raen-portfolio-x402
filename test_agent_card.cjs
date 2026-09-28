// AGENSTRY-W1 cycle-6 acceptance — A2A v1.0 agent card + free JSON-RPC surface
// on raen-portfolio-x402. Mirrors rae-fleet-router test_agent_card.cjs and the
// gateway twin (royal-gateway-x402 PR #2). Critical portfolio-specific assert:
// the card routes are registered ABOVE paymentMiddleware, so even with real
// gating live on /api/portfolio, /.well-known/agent-card.json and POST /a2a
// must NEVER emit 402 or a PAYMENT-REQUIRED header. No secrets, no network,
// no money: x402Server.initialize() runs async against the facilitator but the
// tested routes do not touch it.
// Run: node test_agent_card.cjs
process.env.X402_PAY_TO = process.env.X402_PAY_TO || "0x7861db4efc14a1ed5dd8c96c528a3796560f1393";
const { app, SERVICES, PAY_TO, PRICE } = require("./index.js");

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
}

async function main() {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const rC = await fetch(`${base}/.well-known/agent-card.json`);
    check("GET /.well-known/agent-card.json -> 200 above paymentMiddleware", rC.status === 200, `got ${rC.status}`);
    check("card route never 402 / never payment-required", rC.status !== 402 && !rC.headers.get("payment-required"));
    const card = await rC.json();
    const rOld = await fetch(`${base}/.well-known/agent.json`);
    check("GET /.well-known/agent.json -> 200 (v0.3 URI alias)", rOld.status === 200, `got ${rOld.status}`);

    check("protocolVersion Major.Minor '1.0'", card.protocolVersion === "1.0", card.protocolVersion);
    check("card url is https /a2a", /^https:\/\//.test(card.url || "") && /\/a2a$/.test(card.url || ""), card.url);
    check('supportedInterfaces + preferredTransport JSONRPC', Array.isArray(card.supportedInterfaces) && card.supportedInterfaces[0].transport === 'JSONRPC' && card.preferredTransport === 'JSONRPC');
    check('v1 AgentInterface protocolBinding (REQUIRED for SDK transport matching)', card.supportedInterfaces[0].protocolBinding === 'JSONRPC' && card.supportedInterfaces[0].protocolVersion === '1.0');
    check("provider = Royal Agentic Enterprises", card.provider && card.provider.organization === "Royal Agentic Enterprises");
    check("documentationUrl live /pricing.md", card.documentationUrl === "https://raen-portfolio-x402.fly.dev/pricing.md");
    check(">=3 skills", Array.isArray(card.skills) && card.skills.length >= 3, `skills=${(card.skills || []).length}`);
    check("every skill has id/name/description/tags", (card.skills || []).every((s) => s.id && s.name && s.description && Array.isArray(s.tags) && s.tags.length >= 1));
    check("skill examples list[str] (AgentSkill schema)", (card.skills || []).every((s) => s.examples === undefined || (Array.isArray(s.examples) && s.examples.every((x) => typeof x === "string"))));
    const ext = ((card.capabilities || {}).extensions) || [];
    check("x402 extension names mainnet + canonical treasury", ext.some((e) => /eip155:8453/.test(e.description || "") && e.description.includes(PAY_TO) && PAY_TO === "0x7861db4efc14a1ed5dd8c96c528a3796560f1393"));
    check("card mirrors live constants (8 services, 0.01 price)", card.description.includes(String(SERVICES.length)) && card.skills[0].description.includes(PRICE));

    const rpc = async (payload) => {
      const r = await fetch(`${base}/a2a`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      return { status: r.status, noPay: r.status !== 402 && !r.headers.get("payment-required"), body: await r.json() };
    };
    const v03 = await rpc({ jsonrpc: "2.0", id: 7, method: "message/send", params: { message: { parts: [{ kind: "text", text: "what does the fleet cost?" }] } } });
    check("v0.3 message/send -> 200 in-body result, unbilled", v03.status === 200 && v03.body.result && v03.noPay, `status=${v03.status}`);
    check("guide lists every catalog service with prices", SERVICES.every((s) => v03.body.result.parts[0].text.includes(s.name)));
    check("metadata declares free + payTo", v03.body.result.metadata.free === true && v03.body.result.metadata.x402.payTo === PAY_TO);

    const v1 = await rpc({ jsonrpc: "2.0", id: "a", method: "SendMessage", params: { message: { role: "ROLE_USER", parts: [{ text: "cheapest image generation?" }] } } });
    check("v1 SendMessage protojson: ROLE_AGENT + bare parts", v1.status === 200 && v1.body.result.role === "ROLE_AGENT" && v1.body.result.kind === undefined && v1.body.result.parts[0].kind === undefined);
    check("v1 keyword hit nanobanana via bare part", /nanobanana/i.test(v1.body.result.parts[0].text));
    const gc = await rpc({ jsonrpc: "2.0", id: 3, method: "GetAgentCard", params: {} });
    check("GetAgentCard returns card", gc.body.result && gc.body.result.protocolVersion === "1.0");
    const unk = await rpc({ jsonrpc: "2.0", id: 4, method: "tasks/get", params: {} });
    check("unknown -> -32601 in-body at 200", unk.status === 200 && unk.body.error.code === -32601);
    const bad = await rpc({ nope: 1 });
    check("malformed -> -32600 in-body", bad.body.error.code === -32600);

    // regression: paid flagship still gates (unpaid POST must be 402) — proves the
    // new free surfaces did not disturb the middleware. Per EXEC-52 harness
    // precedent, early requests race x402Server.initialize() (facilitator fetch)
    // and the middleware throws a 500 until ready — retry UNPAID until the gate
    // answers 402 (bounded), then assert. A 500 on a fully-initialized gate
    // would surface as a persistent non-402 within the retry window.
    let paid = null;
    for (let i = 0; i < 12; i++) {
      paid = await fetch(`${base}/api/portfolio`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      if (paid.status === 402) break;
      await new Promise((r) => setTimeout(r, 1500));
    }
    check("paid flagship STILL 402 unpaid (no gate regression)", paid.status === 402, `got ${paid.status}`);
    for (const p of ["/health", "/pricing.md", "/sample", "/.well-known/x402.json"]) {
      const r = await fetch(`${base}${p}`);
      check(`regression ${p} -> 200`, r.status === 200, `got ${r.status}`);
    }
  } finally {
    server.close();
  }
  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILURES"} — portfolio agent-card acceptance`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((e) => { console.error("FATAL", e); process.exit(1); });
