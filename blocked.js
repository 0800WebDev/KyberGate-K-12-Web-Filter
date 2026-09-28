const params = new URLSearchParams(window.location.search);
const domain = params.get("domain") || "Unknown site";
const category = params.get("category") || "Blocked";
const orgId = params.get("orgId") || "";

document.getElementById("blockedDomain").textContent = domain;
document.getElementById("category").textContent = category;

// Also try hash params as fallback
if (domain === "Unknown site" && window.location.hash) {
  try {
    const hp = new URLSearchParams(window.location.hash.slice(1));
    if (hp.get("domain")) document.getElementById("blockedDomain").textContent = hp.get("domain");
    if (hp.get("category")) document.getElementById("category").textContent = hp.get("category");
  } catch {}
}

// Pull student identity from extension storage for unblock requests
let studentEmail = "";
let studentName = "";
let deviceName = "";
let deviceId = "";

(async function loadIdentity() {
  try {
    const stored = await chrome.storage.sync.get(["userEmail", "userName"]);
    studentEmail = stored.userEmail || "";
    studentName = stored.userName || "";
    try {
      const managed = await chrome.storage.managed.get(["deviceName", "deviceId"]);
      deviceName = managed.deviceName || "";
      deviceId = managed.deviceId || "";
    } catch {}
  } catch {}
})();

// ─── Unblock-request gating ───
//
// 🔴 2026-08-17, Excel Academy (Jeremy Seiferth): this page rendered
// "Request Access" UNCONDITIONALLY. It never read the school's
// allowRequestUnblock / denyRequestCategories settings — they weren't even
// synced to the client. Excel had the feature OFF and still received 26 requests
// in a single day, because the button POSTed to an endpoint that also didn't
// check. The endpoint now returns 403, but a button that fails when pressed is
// still wrong: a student must not see an affordance their school disabled.
//
// Mirrors proxy/blockpage.go unblockRequestAllowed() exactly:
//   master switch off            -> hidden for every category
//   category on the deny list    -> hidden (case-insensitive, substring, so
//                                   "Gaming" also matches "AI: Gaming")
//
// ⚠️ FAILS OPEN, deliberately, matching the server. If policy hasn't synced yet,
// or storage read throws, or the org has no custom block page config, the button
// stays. Five other schools have this feature ON and must keep it.
function unblockAllowedByPolicy(policy, cat) {
  if (!policy) return true; // not synced yet — fail open
  if (policy.allowRequestUnblock === false) return false;
  const deny = Array.isArray(policy.denyRequestCategories) ? policy.denyRequestCategories : [];
  if (!deny.length || !cat) return true;
  const lowerCat = String(cat).toLowerCase();
  for (const d of deny) {
    const lowerDenied = String(d || "").toLowerCase();
    if (!lowerDenied) continue; // an empty entry must not act as a wildcard
    if (lowerCat === lowerDenied || lowerCat.includes(lowerDenied)) return false;
  }
  return true;
}

(async function applyUnblockPolicy() {
  const btn = document.getElementById("requestBtn");
  if (!btn) return;
  try {
    const { policy } = await chrome.storage.local.get(["policy"]);
    // The category shown on this page is what the server will judge the request
    // by, so gate on the same value.
    const shownCat = document.getElementById("category")?.textContent || category;
    if (!unblockAllowedByPolicy(policy, shownCat)) {
      btn.remove();
    }
  } catch {
    // fail open — leave the button alone
  }
})();

async function requestAccess() {
  const btn = document.getElementById("requestBtn");
  btn.textContent = "Sending...";
  btn.disabled = true;

  try {
    await fetch("https://proxy.kybergate.com/api/unblock-request", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        domain, orgId, category,
        email: studentEmail,
        studentName: studentName,
        deviceName: deviceName,
        deviceId: deviceId
      })
    });
    btn.textContent = "✓ Request Sent";
    btn.classList.add("sent");
  } catch {
    try {
      // Fallback: try Express API directly
      await fetch("https://app.kybergate.com/api/v1/url-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          orgId,
          domain,
          url: domain,
          category,
          reason: "Requested from block page",
          requestedBy: studentEmail,
          requestedByName: studentName || studentEmail || "Student (Chrome extension)",
          deviceName: deviceName,
          deviceId: deviceId,
          status: "pending",
          source: "chrome-extension"
        })
      });
      btn.textContent = "✓ Request Sent";
      btn.classList.add("sent");
    } catch {
      btn.textContent = "Request Access";
      btn.disabled = false;
    }
  }
}

document.getElementById("requestBtn").addEventListener("click", requestAccess);
document.getElementById("goBackBtn").addEventListener("click", function() { history.back(); });
