// Popup logic

document.addEventListener("DOMContentLoaded", async () => {
  const enrolledView = document.getElementById("enrolled");
  const enrollmentView = document.getElementById("enrollment");
  const orgIdInput = document.getElementById("orgIdInput");
  const deviceNameInput = document.getElementById("deviceNameInput");
  const connectBtn = document.getElementById("connectBtn");

  // Get status from background
  chrome.runtime.sendMessage({ type: "getStatus" }, (res) => {
    if (res && res.enrolled) {
      showEnrolled(res);
    } else {
      showEnrollment();
    }
  });

  function showEnrolled(data) {
    enrolledView.style.display = "block";
    enrollmentView.style.display = "none";

    document.getElementById("blockedCount").textContent = data.stats?.blocked || 0;
    document.getElementById("allowedCount").textContent = data.stats?.allowed || 0;
    document.getElementById("orgIdDisplay").textContent = data.orgId ? data.orgId.slice(0, 16) + "..." : "—";
    document.getElementById("orgName").textContent = data.deviceName || "Connected";

    // Update status based on policy
    if (data.safeSearch || (data.policyCategories && data.policyCategories.length > 0)) {
      document.getElementById("statusText").textContent = "Protected";
      document.getElementById("statusLabel").textContent = "Filter Active";
      document.getElementById("statusDot").className = "status-dot on";
    }
  }

  function showEnrollment() {
    enrolledView.style.display = "none";
    enrollmentView.style.display = "block";
  }

  // Enable button when org ID entered
  orgIdInput.addEventListener("input", () => {
    connectBtn.disabled = orgIdInput.value.trim().length < 8;
  });

  // Connect
  connectBtn.addEventListener("click", async () => {
    const orgId = orgIdInput.value.trim();
    if (!orgId) return;

    connectBtn.disabled = true;
    connectBtn.textContent = "Connecting...";

    chrome.runtime.sendMessage(
      { type: "enroll", orgId, deviceName: deviceNameInput.value.trim() || "Chrome Device" },
      (res) => {
        if (res && res.success) {
          showEnrolled({ enrolled: true, orgId, stats: { blocked: 0, allowed: 0 }, deviceName: deviceNameInput.value.trim() });
        } else {
          connectBtn.disabled = false;
          connectBtn.textContent = "Connect";
          alert("Connection failed. Check the Organization ID and try again.");
        }
      }
    );
  });
});
