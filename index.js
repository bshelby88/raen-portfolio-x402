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
