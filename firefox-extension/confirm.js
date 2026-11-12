// Confirmation page for dashboard-initiated cookie capture and agent connect
// requests (see background.js). For a connect request the per-site permission is
// requested here, inside the user's click, so it is granted at consent time.
const params = new URLSearchParams(window.location.search);
const requestId = params.get("id");
const origin = params.get("origin");
const scopes = params.get("scopes");
document.getElementById("domain").textContent = params.get("domain") || "";

if (scopes !== null) {
  document.getElementById("connect").hidden = false;
  document.getElementById("agent").textContent = params.get("agent") || "An agent";
  document.getElementById("site").textContent = params.get("domain") || "";
  document.getElementById("scopes").textContent = scopes
    .split(",")
    .map((s) => (s === "write" ? "read and act (write)" : "read"))
    .join(", ");
}

function answer(approved) {
  chrome.runtime.sendMessage({ type: "BRIDGE_CONFIRM_RESULT", id: requestId, approved }, () => {
    window.close();
  });
}

document.getElementById("allow").addEventListener("click", async () => {
  if (origin) {
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: [origin] });
    } catch {
      granted = false;
    }
    if (!granted) return answer(false);
  }
  answer(true);
});
document.getElementById("deny").addEventListener("click", () => answer(false));
