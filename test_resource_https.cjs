// EXEC-52 acceptance test — https:// x402 resource advertisement,
// extensions.bazaar presence, and POST fulfillment capability.
//
// Defects proven live 2026-09-23 by CDP validate_endpoint (REJECTED):
//  1. resource.url advertised http:// (Express behind Fly without trust proxy)
//     -> "resource must start with 'https://' when protocol type is http"
//  2. no extensions.bazaar on the route -> required indexing preflight missing
//  3. paid route POST /api/portfolio had NO handler (GET only) -> a buyer who
//     paid would have been 404'd after settlement (fulfillment capability)
//
// Run: node test_resource_https.cjs   (no secrets needed — dummy env only)
process.env.X402_PAY_TO = process.env.X402_PAY_TO || "0x0000000000000000000000000000000000000001";

const { app, portfolioRoute } = require("./index.js");

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!cond) failures++;
}

function decodeChallenge(r) {
  const pr = r.headers.get("payment-required") || r.headers.get("x-payment");
  if (!pr) return null;
  return JSON.parse(Buffer.from(pr, "base64").toString("utf8"));
}

// First requests may race x402Server.initialize(); retry UNPAID until the gate
// emits a real 402 challenge (~60s budget). Nothing is ever paid.
async function challengeReq(url, headers, tries = 60) {
  let last = null;
  for (let i = 0; i < tries; i++) {
    const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
    const c = decodeChallenge(r);
    if (c) return { status: r.status, challenge: c };
    last = r.status;
    await new Promise((res) => setTimeout(res, 1000));
  }
  return { status: last, challenge: null };
}

async function main() {
  const server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    // (1a) direct/cleartext stays honestly http (trust proxy must not fabricate)
    const pPlain = await challengeReq(`${base}/api/portfolio`, {});
    check("POST /api/portfolio (no proxy header) -> 402", pPlain.status === 402, `got ${pPlain.status}`);
    if (pPlain.challenge) {
      check("direct request advertises http:// (no fabricated https)",
        String(pPlain.challenge.resource?.url || "").startsWith("http://127.0.0.1:"), pPlain.challenge.resource?.url);
    }

    // (1b) via https proxy hop -> absolute https://
    const pXfp = await challengeReq(`${base}/api/portfolio`, { "x-forwarded-proto": "https" });
    check("POST /api/portfolio via https proxy hop -> 402", pXfp.status === 402, `got ${pXfp.status}`);
    const c = pXfp.challenge;
    check("challenge present (via https proxy hop)", !!c);
    if (c) {
      check("resource.url is absolute https:// (EXEC-52 fix #1)",
        String(c.resource?.url || "").startsWith(`https://127.0.0.1:${port}/api/portfolio`), c.resource?.url);
      const acc = (c.accepts || [])[0] || {};
      check("scheme exact", acc.scheme === "exact", acc.scheme);
      check("network eip155:8453 (mainnet, env-independent)", acc.network === "eip155:8453", acc.network);
      check("amount >= 1000 atomic (>= $0.001)", Number(acc.amount) >= 1000, String(acc.amount));
      check("USDC asset if advertised matches mainnet USDC",
        !acc.asset || acc.asset.toLowerCase() === "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", acc.asset);
      // (2) bazaar extension on the live challenge
      const bz = c.extensions && c.extensions.bazaar;
      check("extensions.bazaar present on live challenge (EXEC-52 fix #2)", !!bz, JSON.stringify(Object.keys(c.extensions || {})));
      if (bz) {
        check("bazaar info.input method POST", String(bz.info?.input?.method || "").toUpperCase() === "POST", JSON.stringify(bz.info?.input));
        check("bazaar schema declares services", JSON.stringify(bz).includes("services"), "no services in extension");
      }
    }

    // (3) fulfillment capability: POST handler exists behind the gate.
    // We cannot pay in a test; instead prove the Express ROUTER has a POST
    // layer for /api/portfolio (HEAD previously had GET only -> paid 404).
    const layer = (app._router || app.router).stack
      .filter((l) => l.route)
      .find((l) => l.route.path === "/api/portfolio" && l.route.methods.post);
    check("POST /api/portfolio handler registered (paid route is fulfillable)", !!layer,
      layer ? "found" : "no POST layer — paid buyers would 404");

    // route config schema sanity (static)
    check("requestSchema declared", !!portfolioRoute.requestSchema && portfolioRoute.requestSchema.type === "object");
    check("responseSchema requires services+health enum",
      JSON.stringify(portfolioRoute.responseSchema?.properties?.services?.items?.properties?.health || "").includes("unreachable"));
  } finally {
    server.close();
  }

  console.log(failures === 0 ? "ALL PASS (portfolio EXEC-52)" : `${failures} FAILURE(S) (portfolio EXEC-52)`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((e) => { console.error("HARNESS ERROR:", e); process.exit(2); });
