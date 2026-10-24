const $ = (id) => document.getElementById(id);

async function init() {
  const { server = "", token = "", lastUpload } = await chrome.storage.local.get(["server", "token", "lastUpload"]);
  $("server").value = server; $("token").value = token;
  if (lastUpload) $("last").textContent = lastUpload.ok
    ? `Last sent: ${lastUpload.title} (${new Date(lastUpload.at).toLocaleTimeString()})`
    : `Last upload failed: ${lastUpload.error}. It will be retried.`;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    const s = await chrome.tabs.sendMessage(tab.id, { type: "status" });
    $("state").textContent = s.lines ? `${s.platform}: captured ${s.lines} caption lines from “${s.title}”.` : `${s.platform}: no captions yet. Turn captions on in the call.`;
    $("send").hidden = !s.lines;
  } catch { /* not on a supported page */ }
}

$("save").onclick = async () => {
  const server = $("server").value.trim().replace(/\/+$/, "");
  // Ask for access to just this server instead of every site.
  if (server && !(await chrome.permissions.request({ origins: [`${new URL(server).origin}/*`] }))) { $("msg").textContent = "Permission to reach that server was denied."; return; }
  await chrome.storage.local.set({ server, token: $("token").value.trim() });
  $("msg").textContent = "Saved.";
};
$("test").onclick = async () => {
  const r = await chrome.runtime.sendMessage({ type: "test" });
  $("msg").textContent = r.ok ? "Connected." : r.status === 401 ? "Token rejected." : `Failed: ${r.error ?? r.status}`;
};
$("send").onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await chrome.tabs.sendMessage(tab.id, { type: "send" });
  $("msg").textContent = "Sending… the summary appears under Meeting notes.";
};
init();
