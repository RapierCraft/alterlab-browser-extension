/**
 * AlterLab Connect: recorder review panel (#38945). Start/stop a recording, review the
 * draft, rename parameters, name the recipe and save it to POST /api/v1/workflows/from-recording.
 */
(function (root) {
  "use strict";

  const R = () => root.AlterLabRecorder;

  function send(msg) {
    return new Promise((resolve) => chrome.runtime.sendMessage(msg, (r) => resolve(r || {})));
  }

  async function saveDraft(config, payload, fetchFn) {
    const resp = await (fetchFn || fetch)(`${config.apiUrl}/api/v1/workflows/from-recording`, {
      method: "POST",
      headers: { "X-API-Key": config.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) throw new Error(`Save failed (${resp.status})`);
    return resp.json();
  }

  function mount(el, getConfig) {
    if (!el || !R()) return;
    let steps = [];
    let startUrl = "";
    el.innerHTML =
      '<details><summary>Record a recipe</summary>' +
      '<p class="al-text-muted">Do the task once in this tab. Typed values are never saved: they become named parameters, and passwords become secret references.</p>' +
      '<button id="recStart" type="button">Start recording</button> ' +
      '<button id="recStop" type="button" hidden>Stop</button>' +
      '<div id="recDraft" hidden><input id="recName" placeholder="Recipe name" maxlength="255" />' +
      '<ol id="recSteps"></ol><button id="recSave" type="button">Save recipe</button></div>' +
      '<div id="recStatus" role="status"></div></details>';
    const $ = (id) => el.querySelector(id);
    const status = (t) => ($("#recStatus").textContent = t);

    function renderSteps() {
      const list = $("#recSteps");
      list.textContent = "";
      steps.forEach((s) => {
        const li = document.createElement("li");
        const label = s.url || s.selector;
        li.textContent = `${s.type} ${label} `;
        const key = s.param || s.secret;
        if (key) {
          const input = document.createElement("input");
          input.value = key;
          input.setAttribute("aria-label", s.secret ? "Secret name" : "Parameter name");
          input.addEventListener("change", () => {
            try {
              steps = R().renameField(steps, key, input.value);
              renderSteps();
            } catch (e) {
              status(e.message);
            }
          });
          li.appendChild(input);
        }
        list.appendChild(li);
      });
    }

    $("#recStart").addEventListener("click", async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || !/^https?:/.test(tab.url || "")) return status("Open a website tab first.");
      const originPattern = `${new URL(tab.url).origin}/*`;
      const granted = await chrome.permissions.request({ origins: [originPattern] });
      if (!granted) return status("Site permission is required to record.");
      const res = await send({ type: "RECORDER_START", tabId: tab.id, url: tab.url });
      if (!res.success) return status(res.error || "Could not start recording.");
      startUrl = tab.url;
      $("#recStart").hidden = true;
      $("#recStop").hidden = false;
      status("Recording this tab only.");
    });

    $("#recStop").addEventListener("click", async () => {
      const res = await send({ type: "RECORDER_STOP" });
      steps = (res && res.steps) || [];
      $("#recStop").hidden = true;
      $("#recStart").hidden = false;
      $("#recDraft").hidden = steps.length === 0;
      status(steps.length ? `${steps.length} steps captured. Review and save.` : "No steps captured.");
      renderSteps();
    });

    $("#recSave").addEventListener("click", async () => {
      const name = $("#recName").value.trim();
      if (!name) return status("Name the recipe first.");
      const config = await getConfig();
      const draft = { name, start_url: startUrl, steps };
      try {
        const wf = await saveDraft(config, draft);
        status(`Saved recipe ${wf.name}. Its first run asks for approval on any write step.`);
        $("#recDraft").hidden = true;
      } catch (e) {
        status(e.message);
      }
    });
  }

  root.AlterLabRecorderPanel = { mount, saveDraft };
})(typeof self !== "undefined" ? self : this);
