// Credential request prompt (#39876). Mirrors the dashboard entry page: the user types the
// values here, they are sealed in this page (AlterLabHandsCredentials) and only ciphertext is
// posted. Inputs are cleared after sending; values are never stored, logged or messaged.
const params = new URLSearchParams(window.location.search);
const requestId = params.get("id");
const statusEl = document.getElementById("status");
const form = document.getElementById("form");
let current = null;

function say(text) {
  statusEl.textContent = text;
}

async function deps() {
  const cfg = await new Promise((resolve) => chrome.storage.local.get(["apiUrl"], resolve));
  return {
    fetch: (...args) => fetch(...args),
    baseUrl: cfg.apiUrl || "https://alterlab.io",
    headers: {},
    crypto: globalThis.crypto,
  };
}

function render(req) {
  const H = AlterLabHandsCredentials;
  document.getElementById("domain").textContent = req.domain;
  document.getElementById("site").textContent = req.domain;
  document.getElementById("reason").textContent = req.reason || "Not stated";
  document.getElementById("retention").textContent = H.retention(req);
  const box = document.getElementById("fields");
  box.textContent = "";
  for (const field of req.fields || []) {
    const label = document.createElement("label");
    label.textContent = H.fieldLabel(field);
    label.htmlFor = "f_" + field.name;
    const input = document.createElement("input");
    input.id = "f_" + field.name;
    input.dataset.name = field.name;
    input.type = field.sensitive === false ? "text" : "password";
    input.required = true;
    input.autocomplete = "off";
    box.append(label, input);
  }
}

async function load() {
  if (!requestId) return say("No request id.");
  current = await AlterLabHandsCredentials.getRequest(requestId, await deps());
  if (!current || current.status !== "pending") {
    form.hidden = true;
    return say("This request is no longer pending.");
  }
  render(current);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const inputs = Array.from(document.querySelectorAll("#fields input"));
  const values = {};
  for (const input of inputs) values[input.dataset.name] = input.value;
  try {
    await AlterLabHandsCredentials.provide(
      requestId,
      document.getElementById("short_code").value.trim(),
      values,
      await deps(),
    );
    form.hidden = true;
    say("Sealed and sent. You can close this tab.");
  } catch (err) {
    say(err.code === "INVALID_CODE" ? "That short code is not right." : err.message || "Failed.");
  } finally {
    for (const input of inputs) input.value = "";
  }
});

document.getElementById("decline").addEventListener("click", async () => {
  const ok = await AlterLabHandsCredentials.decline(requestId, await deps());
  form.hidden = ok;
  say(ok ? "Declined." : "Could not decline.");
});

// Alternative: share a signed-in session for this site instead of typing credentials.
document.getElementById("connect").addEventListener("click", () => {
  if (!current) return;
  chrome.runtime.sendMessage(
    { type: "CONNECT_REQUEST", request: { site: current.domain, scopes: ["read"] } },
    (resp) => say(resp && resp.error ? resp.error : "Session connected."),
  );
});

load().catch(() => say("Could not load the request."));
