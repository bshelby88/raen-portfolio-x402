const express = require("express");
const https = require("https");
const { paymentMiddleware } = require("@x402/express");
const { x402ResourceServer, HTTPFacilitatorClient } = require("@x402/core/server");
const { ExactEvmScheme } = require("@x402/evm/exact/server");
const { declareDiscoveryExtension } = require("@x402/extensions/bazaar");

const PAY_TO = process.env.X402_PAY_TO || "0x7861db4efc14a1ed5dd8c96c528a3796560f1393";
if (!/^0x[a-fA-F0-9]{40}$/.test(PAY_TO)) {
  console.error("FATAL: X402_PAY_TO invalid");
  process.exit(1);
}

const NETWORK = "eip155:8453";
const PRICE = "0.01";

const SERVICES = [
  { name: "sentry-forge", url: "https://sentry-forge-x402.fly.dev/api/dispute-pack", price: "$5.00", desc: "8-file consumer-debt dispute pack" },
  { name: "royal-ruby", url: "https://royal-ruby-x402.fly.dev/api/law-lookup", price: "$0.25", desc: "US consumer-rights law citation lookup" },
  { name: "vault-pro", url: "https://vault-pro-x402.fly.dev/api/scaffold-project", price: "$0.05", desc: "Obsidian project/agent scaffolder" },
  { name: "tradingagents", url: "https://tradingagents-x402.fly.dev/api/analyze-ticker", price: "$0.05", desc: "Multi-agent LLM ticker analysis" },
  { name: "power-pack", url: "https://power-pack-x402.fly.dev/api/score-email", price: "$0.01", desc: "Outreach email QA scorer" },
  { name: "suprapack", url: "https://suprapack-x402.fly.dev/api/find-skill", price: "$0.03", desc: "Skill discovery over 531-skill bundle" },
  { name: "nanobanana", url: "https://nanobanana-x402.fly.dev/api/generate-image", price: "$0.01", desc: "Gemini image generation" },
  { name: "nft-alpha", url: "https://nft-alpha-x402.fly.dev/api/nft-signal", price: "$0.02", desc: "NFT floor-movement signal" },
];

const app = express();
// EXEC-52: behind Fly's reverse proxy Express reports req.protocol === "http"
// unless the proxy hop is trusted, and @x402/express derives the advertised
// x402 resource URL from the request origin. Cleartext scheme made CDP Bazaar
// reject indexing: "resource must start with 'https://' when protocol type is
// http". Trusting the first (Fly) hop makes req.protocol === "https" in prod.
app.set("trust proxy", 1);
app.use(express.json({ limit: "256kb" }));

async function request(options, body, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`probe timeout ${timeoutMs}ms`)));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function probeHealth(base) {
  try {
    const r = await request({ hostname: new URL(base).hostname, path: "/health", method: "GET" });
    return r.status === 200 ? "ok" : "degraded";
  } catch { return "unreachable"; }
}

// --- Route configs ---
// Machine contract for POST /api/portfolio. Empty body {} is accepted; extra
// keys are tolerated (additionalProperties true — the endpoint ignores them).
const PORTFOLIO_INPUT_SCHEMA = {
  type: "object",
  description: "No parameters required. Send an empty JSON object {}.",
  additionalProperties: true,
};
const PORTFOLIO_OUTPUT_SCHEMA = {
  type: "object",
  required: ["ok", "paid", "services", "timestamp"],
  properties: {
    ok: { type: "boolean" },
    paid: { type: "boolean", const: true },
    price: { type: "string" },
    network: { type: "string" },
    payTo: { type: "string" },
    timestamp: { type: "string", description: "ISO-8601 generation time" },
    services: {
      type: "array",
      minItems: 8,
      items: {
        type: "object",
        required: ["name", "url", "price", "desc", "health"],
        properties: {
          name: { type: "string" },
          url: { type: "string", description: "Absolute https:// x402 endpoint" },
          price: { type: "string" },
          desc: { type: "string" },
          health: { type: "string", enum: ["ok", "degraded", "unreachable"], description: "Live /health probe taken at request time" },
        },
      },
    },
    integration_guide: {
      type: "object",
      properties: {
        python: { type: "string" },
        curl: { type: "string" },
        constants: { type: "object", properties: { payTo: { type: "string" }, asset: { type: "string" }, facilitator: { type: "string" }, network: { type: "string" } } },
      },
    },
  },
};

const portfolioRoute = {
  accepts: { scheme: "exact", price: `$${PRICE}`, network: NETWORK, payTo: PAY_TO, extra: { facilitator: "https://x402-agent-pay.com/facilitator" } },
  description: "Live fleet health + copy-paste integration recipes for all 8 RAEN services (Python, JS, MCP).",
  mimeType: "application/json",
  requestSchema: PORTFOLIO_INPUT_SCHEMA,
  responseSchema: PORTFOLIO_OUTPUT_SCHEMA,
  // EXEC-52: extensions.bazaar is a REQUIRED preflight for CDP Bazaar
  // indexing; this wall shipped none, so it could never be accepted.
  extensions: {
    ...declareDiscoveryExtension({
      method: "POST",
      bodyType: "json",
      input: {},
      inputSchema: PORTFOLIO_INPUT_SCHEMA,
      output: {
        example: {
          ok: true, paid: true, price: PRICE, network: NETWORK, payTo: PAY_TO,
          timestamp: "2026-09-24T00:00:00.000Z",
          services: SERVICES.map((s) => ({ ...s, health: "ok" })),
          integration_guide: { python: "…", curl: "curl -sN -X POST https://raen-portfolio-x402.fly.dev/api/portfolio -H \"Content-Type: application/json\" -d '{}' -H 'PAYMENT-SIGNATURE: …'", constants: { payTo: PAY_TO, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", facilitator: "https://x402-agent-pay.com/facilitator", network: NETWORK } },
        },
        schema: PORTFOLIO_OUTPUT_SCHEMA,
      },
    }),
  },
};

const routesConfig = { "POST /api/portfolio": portfolioRoute };

// --- Facilitator ---
const facilitatorClient = new HTTPFacilitatorClient({ url: "https://x402-agent-pay.com/facilitator" });
const x402Server = new x402ResourceServer(facilitatorClient);
x402Server.register(NETWORK, new ExactEvmScheme());

(async () => {
  for (let i = 1; i <= 12; i++) {
    try { await x402Server.initialize(); console.log(`-> x402 facilitator ready (attempt ${i})`); return; }
    catch (e) { console.warn(`x402 init attempt ${i}/12: ${e?.message}`); await new Promise((r) => setTimeout(r, Math.min(2000 * i, 15000))); }
  }
  console.warn("x402 not ready after retries; lazy init on first paid call");
})();

// ---------------------------------------------------------------------------
// AGENSTRY-W1 cycle-6 (recO9y9mCEnExkp3W, 2026-09-28) — A2A v1.0 agent card +
// free JSON-RPC SendMessage surface. Proven playbook: rae-fleet-router PR #6
// (merged 2a81afba) then royal-gateway-x402 PR #2 (Agenstry instant-page
// confirmed 12:3xZ) — directories crawl /.well-known/agent-card.json and the
// sole indexing blocker was the missing card (404). Registered ABOVE
// paymentMiddleware: these routes can never emit 402, never call a paid
// downstream service, never move money. All claims derived from this file's
// own SERVICES/PAY_TO/PRICE constants — the live 402 challenge stays
// authoritative for the paid endpoint.
// ---------------------------------------------------------------------------
function pfCardUrl(req) {
  return `https://${req.get("host") || "raen-portfolio-x402.fly.dev"}/a2a`;
}
function portfolioAgentCard(req) {
  const skills = [
    {
      id: "portfolio-health-recipes", name: "RAEN fleet portfolio report (paid)",
      description: `POST /api/portfolio — ${PRICE} USDC on Base (${NETWORK}) returns live health probes + integration recipes for all ${SERVICES.length} RAEN services. Paid path only via the x402 402 challenge on that route.`,
      tags: ["portfolio", "health", "integration", "x402", "usdc", "base"],
      examples: ["Show me the live status and integration recipes for all RAEN services."],
    },
    {
      id: "fleet-service-guide", name: "Fleet service guide (free)",
      description: `Ask this agent in plain text what the ${SERVICES.length} RAEN x402 services do, what each costs, and the exact endpoint URL — answered free over A2A JSON-RPC with no payment and no downstream calls.`,
      tags: ["catalog", "pricing", "discovery", "x402", "free"],
      examples: ["Which RAEN service gives NFT floor signals and what does it cost?"],
    },
    {
      id: "cheapest-task-finder", name: "Cheapest endpoint finder (free)",
      description: "Given a task (image generation, dispute pack, email scoring, skill search, legal lookup...), returns the cheapest matching catalog endpoint with method+URL+price, derived from the same SERVICES table as /pricing.md.",
      tags: ["pricing", "optimization", "x402", "usdc", "base"],
      examples: ["Cheapest way to generate an image and to score an outreach email?"],
    },
    {
      id: "x402-payment-onboarding", name: "x402 payment onboarding (free)",
      description: "Explains the 4-step x402 v2 flow: POST unpaid, decode the 402 PAYMENT-REQUIRED header, sign a USDC EIP-3009 transferWithAuthorization on Base, resend with PAYMENT-SIGNATURE. Names the canonical treasury from the live manifest.",
      tags: ["x402", "usdc", "eip-3009", "onboarding", "free"],
      examples: ["How does an agent pay this endpoint with USDC on Base?"],
    },
  ];
  return {
    name: "RAEN Portfolio x402 — Fleet Health & Integration Recipes",
    description: `Royal Agentic (RAEN) fleet portfolio wall: one ${PRICE} USDC call on Base returns live health + integration recipes for all ${SERVICES.length} x402 services (sentry-forge, royal-ruby, vault-pro, tradingagents, power-pack, suprapack, nanobanana, nft-alpha). Free A2A guidance + machine-readable pricing at /.well-known/x402.json.`,
    version: "1.0.0",
    protocolVersion: "1.0",
    url: pfCardUrl(req),
    supportedInterfaces: [{ url: pfCardUrl(req), transport: "JSONRPC", protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
    preferredTransport: "JSONRPC",
    provider: { organization: "Royal Agentic Enterprises", url: "https://royal-gateway-x402.fly.dev" },
    documentationUrl: "https://raen-portfolio-x402.fly.dev/pricing.md",
    capabilities: {
      streaming: false,
      pushNotifications: false,
      stateTransitionHistory: false,
      extensions: [
        { uri: "https://x402.org", description: `x402 v2 payment gating: USDC (eip155:8453, contract 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913), scheme exact, payTo treasury ${PAY_TO}. The live 402 challenge is authoritative.`, required: false },
      ],
    },
    defaultInputModes: ["application/json", "text/plain"],
    defaultOutputModes: ["application/json", "text/plain"],
    skills,
    securitySchemes: {},
    security: [],
  };
}
function portfolioGuideText() {
  const table = SERVICES.map((s) => `- ${s.name}: ${s.desc} — POST ${s.url} ${s.price}`).join("\n");
  return `RAEN Portfolio x402 (${SERVICES.length} services, USDC on Base ${NETWORK}, treasury ${PAY_TO}). Paid here: POST /api/portfolio ${PRICE} USDC — live health + integration recipes for every service below. ${table}\nFree surfaces: /sample (shape demo), /pricing.md, /llms.txt, /.well-known/x402.json. To pay anything: POST unpaid, decode the 402 PAYMENT-REQUIRED header, sign a USDC EIP-3009 transferWithAuthorization, resend with PAYMENT-SIGNATURE. The live 402 challenge is authoritative — prices there beat this text.`;
}
function portfolioKeywordHint(lower) {
  const hits = SERVICES.filter((s) => {
    const key = `${s.name} ${s.desc}`.toLowerCase();
    const want = /nft/.test(lower) ? "nft" :
      /image|picture/.test(lower) ? "image" :
      /email|outreach|scor/.test(lower) ? "email" :
      /dispute|debt|refund/.test(lower) ? "dispute" :
      /law|legal|right|citation/.test(lower) ? "law" :
      /skill/.test(lower) ? "skill" :
      /ticker|trading|market/.test(lower) ? "ticker" :
      /obsidian|scaffold|project/.test(lower) ? "scaffold" : null;
    return want && key.includes(want);
  }).slice(0, 4);
  return hits.length ? `\n\nMatched: ${hits.map((s) => `${s.name} POST ${s.url} ${s.price}`).join(" | ")}` : "";
}
app.get(["/.well-known/agent-card.json", "/.well-known/agent.json"], (req, res) => {
  res.set("Cache-Control", "public, max-age=60");
  res.json(portfolioAgentCard(req));
});
app.post("/a2a", (req, res) => {
  const b = req.body || {};
  const id = b.id !== undefined ? b.id : null;
  if (b.jsonrpc !== "2.0" || typeof b.method !== "string") {
    return res.json({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request: expected JSON-RPC 2.0 with a method string" } });
  }
  if (b.method === "SendMessage" || b.method === "message/send" || b.method === "tasks/send") {
    // Wire-format negotiation by the method the caller used (Agenstry validator:
    // "SendMessage for v1, message/send for v0.3"). A2A v1.0 is protojson:
    // role ROLE_AGENT enum + bare oneof parts ({"text":...}, no "kind").
    // v0.3 keeps kind/agent. Inbound parts accepted in BOTH shapes.
    const v1 = b.method === "SendMessage";
    const userText = (((b.params || {}).message || {}).parts || [])
      .filter((p) => p && typeof p.text === "string")
      .map((p) => p.text).join(" ").slice(0, 500);
    const answer = portfolioGuideText() + portfolioKeywordHint(userText.toLowerCase());
    const metadata = { free: true, x402: { network: NETWORK, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", payTo: PAY_TO, manifest: "/.well-known/x402.json" } };
    const messageId = `r-${Date.now()}`;
    const result = v1
      ? { messageId, role: "ROLE_AGENT", parts: [{ text: answer }], metadata }
      : { kind: "message", role: "agent", messageId, parts: [{ kind: "text", text: answer }], metadata };
    return res.json({ jsonrpc: "2.0", id, result });
  }
  if (b.method === "GetAgentCard") {
    return res.json({ jsonrpc: "2.0", id, result: portfolioAgentCard(req) });
  }
  return res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found: supported are SendMessage (v1), message/send (v0.3), GetAgentCard" } });
});
// --- End AGENSTRY-W1 free surfaces ---

app.use(paymentMiddleware(routesConfig, x402Server, undefined, undefined, false));

// --- Routes ---
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "raen-portfolio", payTo: PAY_TO, price: PRICE, network: NETWORK });
});

app.get(["/.well-known/x402", "/.well-known/x402.json"], (_req, res) => {
  res.json({
    version: "2.0.0",
    service: { name: "raen-portfolio", description: "RAEN fleet portfolio — live health + integration recipes for all 8 services.", contact: "jadedfocus@gmail.com", operator: "Royal Agentic Enterprises" },
    endpoints: { "/api/portfolio": { method: "POST", accepts: portfolioRoute.accepts, description: portfolioRoute.description, mimeType: portfolioRoute.mimeType } },
  });
});

app.get("/sample", (_req, res) => {
  res.json({
    ok: true, free: true, paid_endpoint: "POST /api/portfolio", price: PRICE, network: NETWORK,
    note: "Synthetic demo. Paid call returns live health + integration recipes.",
    services: SERVICES.map(s => ({ ...s, health: "ok" })),
    integration_snippet: `curl -sN -X POST https://raen-portfolio-x402.fly.dev/api/portfolio -H "Content-Type: application/json" -d '{}'`,
  });
});

function integrationGuide() {
  return {
    python: `from x402_httpx import X402Client\nwith X402Client(private_key=os.environ["BUYER_PRIVATE_KEY"], network="eip155:8453") as c:\n    r = c.post("https://raen-portfolio-x402.fly.dev/api/portfolio", json={})\n    print(r.json())`,
    curl: `curl -sN -X POST https://raen-portfolio-x402.fly.dev/api/portfolio -H "Content-Type: application/json" -d '{}'`,
    constants: { payTo: PAY_TO, asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", facilitator: "https://x402-agent-pay.com/facilitator", network: NETWORK },
  };
}

// EXEC-52 fulfillment fix: the paid route is POST /api/portfolio, but HEAD
// only registered a GET handler — a buyer who paid would have been 404'd
// after settlement. POST now answers with LIVE health probes (the paid
// delta); GET remains the free static preview it always was.
app.post("/api/portfolio", async (_req, res) => {
  const services = await Promise.all(SERVICES.map(async (s) => ({ ...s, health: await probeHealth(s.url) })));
  res.json({
    ok: true, paid: true, price: PRICE, network: NETWORK, payTo: PAY_TO, timestamp: new Date().toISOString(),
    services,
    integration_guide: integrationGuide(),
  });
});

app.get("/api/portfolio", (_req, res) => {
  res.json({
    ok: true, paid: true, price: PRICE, network: NETWORK, payTo: PAY_TO, timestamp: new Date().toISOString(),
    services: SERVICES.map(s => ({ ...s, health: "ok" })),
    integration_guide: integrationGuide(),
  });
});

app.get("/", (_req, res) => {
  res.type("html").sendFile(require("path").join(__dirname, "index.html"));
});

app.get("/pricing.md", (_req, res) => {
  res.type("text/markdown").send(`# RAEN Portfolio — Pricing\n\n- Price: **${PRICE} USDC per request**\n- Network: Base mainnet (${NETWORK})\n- Paid endpoint: POST /api/portfolio\n- PayTo: ${PAY_TO}\n- Facilitator: https://x402-agent-pay.com/facilitator\n\nReturns live health + integration recipes for all 8 RAEN services.\n`);
});

app.get("/llms.txt", (_req, res) => {
  res.type("text/plain").send(`# RAEN Portfolio x402\n\n> Pay ${PRICE} USDC, get live health + integration recipes for all 8 RAEN services.\n\n- Paid endpoint: POST https://raen-portfolio-x402.fly.dev/api/portfolio\n- Price: ${PRICE} USDC\n- Network: Base mainnet (${NETWORK})\n- x402 manifest: https://raen-portfolio-x402.fly.dev/.well-known/x402.json\n- Health: https://raen-portfolio-x402.fly.dev/health\n- Sample: https://raen-portfolio-x402.fly.dev/sample\n`);
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`-> RAEN Portfolio x402 listening on :${PORT}`);
    console.log(`-> Receive address: ${PAY_TO}`);
    console.log(`-> Test: curl -i -X POST http://localhost:${PORT}/api/portfolio -H 'content-type: application/json' -d '{}'`);
  });
}

module.exports = { app, portfolioRoute, SERVICES, PAY_TO, NETWORK, PRICE };
