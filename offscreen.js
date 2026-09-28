// KyberGate Offscreen Document — Geolocation + Tab Capture
// Manifest V3 service workers can't use navigator.geolocation or
// getUserMedia directly. This offscreen document bridges that gap.

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "getGeolocation") {
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        sendResponse({
          success: true,
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          source: "gps",
        });
      },
      (err) => {
        console.log("📍 Geolocation failed, will use IP fallback:", err.message);
        sendResponse({
          success: false,
          error: err.message,
        });
      },
      {
        enableHighAccuracy: false,
        timeout: 10000,
        maximumAge: 300000, // 5 minutes cache is fine
      }
    );
    return true; // keep channel open for async response
  }

  if (msg.type === "capture-tab-frame") {
    captureTabFrame(msg.streamId, msg.maxWidth || 1280)
      .then((base64) => sendResponse({ base64 }))
      .catch((err) => sendResponse({ error: err.message }));
    return true; // async
  }

  return false;
});

// ── Tab Capture Frame Grab ─────────────────────────────────
// Takes a tabCapture stream ID, opens a MediaStream via
// getUserMedia, grabs a single video frame, and returns it
// as a JPEG base64 string.
async function captureTabFrame(streamId, maxWidth) {
  // Get the media stream from the tab capture stream ID
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
  });

  try {
    const video = document.createElement("video");
    video.srcObject = stream;
    video.muted = true;
    await video.play();

    // Wait for at least one frame to be available
    await new Promise((resolve) => {
      if (video.readyState >= 2) return resolve();
      video.addEventListener("loadeddata", resolve, { once: true });
      // Safety timeout
      setTimeout(resolve, 2000);
    });

    const origW = video.videoWidth || 1280;
    const origH = video.videoHeight || 720;

    // Scale down preserving aspect ratio
    const scale = origW > maxWidth ? maxWidth / origW : 1;
    const targetW = Math.round(origW * scale);
    const targetH = Math.round(origH * scale);

    const canvas = new OffscreenCanvas(targetW, targetH);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(video, 0, 0, targetW, targetH);

    // Stop video playback
    video.pause();
    video.srcObject = null;

    // Convert to JPEG base64
    const jpegBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.75 });
    const arrayBuf = await jpegBlob.arrayBuffer();
    const uint8 = new Uint8Array(arrayBuf);
    let binary = "";
    for (let i = 0; i < uint8.length; i++) {
      binary += String.fromCharCode(uint8[i]);
    }
    return btoa(binary);
  } finally {
    // Always stop the stream tracks to release resources
    stream.getTracks().forEach((t) => t.stop());
  }
}
