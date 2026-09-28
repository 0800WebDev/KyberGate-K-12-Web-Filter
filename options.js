chrome.storage.sync.get(["orgId", "deviceId", "deviceName"], (data) => {
  const enrolled = !!data.orgId;
  document.getElementById("status").textContent = enrolled ? "Connected" : "Not Connected";
  document.getElementById("status").className = "status-badge " + (enrolled ? "online" : "offline");
  document.getElementById("orgId").textContent = data.orgId || "—";
  document.getElementById("deviceId").textContent = data.deviceId ? data.deviceId.slice(0, 12) + "..." : "—";
  document.getElementById("deviceName").textContent = data.deviceName || "—";
});

chrome.storage.local.get(["policy", "lastPolicySync"], (data) => {
  if (data.lastPolicySync) {
    document.getElementById("lastSync").textContent = new Date(data.lastPolicySync).toLocaleString();
  }
  if (data.policy) {
    const p = data.policy;
    const cats = p.blockedCategories || [];
    document.getElementById("safesearch").textContent = p.safeSearch ? "Enforced" : "Off";
    document.getElementById("gameBlock").textContent = p.blockGames || cats.includes("gaming") ? "Active" : "Off";
    document.getElementById("aiBlock").textContent = cats.includes("ai-tools") ? "Blocked" : "Allowed";
    document.getElementById("vpnBlock").textContent = cats.includes("proxy-vpn") ? "Active" : "Off";
    document.getElementById("distractionBlock").textContent = p.distractionHidingEnabled ? "Active" : "Off";
  }
});

// Show version from manifest
const manifest = chrome.runtime.getManifest();
const versionEl = document.getElementById("version");
if (versionEl) versionEl.textContent = manifest.version;

// Check if org allows unenrollment — hide disconnect button if not.
// Check managed storage first (tamper-proof), then fall back to local.
async function checkUnenrollAllowed() {
  const disconnectBtn = document.getElementById("disconnectBtn");
  if (!disconnectBtn) return;

  let allowed = false;
  try {
    const managed = await chrome.storage.managed.get(["allowUnenroll"]);
    if (managed.allowUnenroll !== undefined) {
      allowed = managed.allowUnenroll === true;
    } else {
      const data = await chrome.storage.local.get("orgSettings");
      allowed = (data.orgSettings || {}).allowUnenroll === true;
    }
  } catch {
    const data = await chrome.storage.local.get("orgSettings");
    allowed = (data.orgSettings || {}).allowUnenroll === true;
  }
  disconnectBtn.style.display = allowed ? "" : "none";
}
checkUnenrollAllowed();

document.getElementById("disconnectBtn").addEventListener("click", async () => {
  // Double-check org setting before allowing disconnect (managed-first)
  let allowed = false;
  try {
    const managed = await chrome.storage.managed.get(["allowUnenroll"]);
    if (managed.allowUnenroll !== undefined) {
      allowed = managed.allowUnenroll === true;
    } else {
      const data = await chrome.storage.local.get("orgSettings");
      allowed = (data.orgSettings || {}).allowUnenroll === true;
    }
  } catch {
    const data = await chrome.storage.local.get("orgSettings");
    allowed = (data.orgSettings || {}).allowUnenroll === true;
  }
  if (!allowed) {
    alert("Your organization does not allow device unenrollment.");
    return;
  }
  if (confirm("Disconnect from KyberGate? Filtering will stop.")) {
    chrome.runtime.sendMessage({ type: "unenroll" }, () => {
      location.reload();
    });
  }
});
