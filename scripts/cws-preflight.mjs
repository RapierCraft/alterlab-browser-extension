#!/usr/bin/env node
// Fail early and loudly when the Chrome Web Store credentials cannot work.
// Reads CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN, PUBLISHER_ID, EXTENSION_ID from the
// environment; prints only non-secret diagnostics.
const need = ["CLIENT_ID", "CLIENT_SECRET", "REFRESH_TOKEN", "PUBLISHER_ID", "EXTENSION_ID"];
const missing = need.filter((k) => !process.env[k]);
if (missing.length) {
  console.error(
    `::error::Chrome Web Store publish is not configured: missing ${missing.join(", ")}. ` +
      "The v2 API needs the publisher ID (repo secret CWS_PUBLISHER_ID); the old v1.1 API is retired.",
  );
  process.exit(1);
}
const res = await fetch("https://oauth2.googleapis.com/token", {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    client_id: process.env.CLIENT_ID,
    client_secret: process.env.CLIENT_SECRET,
    refresh_token: process.env.REFRESH_TOKEN,
    grant_type: "refresh_token",
  }),
});
const body = await res.json().catch(() => ({}));
if (!body.access_token) {
  console.error(
    `::error::Google rejected the Chrome Web Store refresh token (${body.error || res.status}: ` +
      `${body.error_description || "no detail"}). Mint a new CWS_REFRESH_TOKEN for the developer account.`,
  );
  process.exit(1);
}
const status = await fetch(
  `https://chromewebstore.googleapis.com/v2/publishers/${process.env.PUBLISHER_ID}/items/${process.env.EXTENSION_ID}:fetchStatus`,
  { headers: { authorization: `Bearer ${body.access_token}` } },
);
const text = await status.text();
if (!status.ok) {
  console.error(`::error::Chrome Web Store fetchStatus failed (HTTP ${status.status}): ${text.slice(0, 500)}`);
  process.exit(1);
}
console.log(`Chrome Web Store credentials OK. Current item state: ${text.slice(0, 800)}`);
