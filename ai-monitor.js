// KyberGate AI Chat Monitor — Content Script
// Injected into ChatGPT, Claude, Gemini, Perplexity, DeepSeek, Copilot, Meta AI, Grok,
// Poe, You.com, HuggingChat, Mistral, Pi, Character.AI, AI Studio, NotebookLM
// Also handles unknown AI chat sites when injected by background auto-detection
// Captures student prompts + AI responses and sends to background for Firestore logging

(function () {
  "use strict";

  // Prevent double-injection
  if (window.__kyberAiMonitor) return;
  window.__kyberAiMonitor = true;

  // ============================================================
  // Platform Detection
  // ============================================================

  const PLATFORMS = {
    "chatgpt.com": "ChatGPT",
    "chat.openai.com": "ChatGPT",
    "claude.ai": "Claude",
    "gemini.google.com": "Gemini",
    "perplexity.ai": "Perplexity",
    "chat.deepseek.com": "DeepSeek",
    "copilot.microsoft.com": "Copilot",
    "meta.ai": "Meta AI",
    "grok.x.ai": "Grok",
    "x.ai": "Grok",
    "poe.com": "Poe",
    "you.com": "You.com",
    "huggingface.co": "HuggingChat",
    "chat.mistral.ai": "Mistral",
    "pi.ai": "Pi",
    "character.ai": "Character.AI",
    "www.character.ai": "Character.AI",
    "aistudio.google.com": "AI Studio",
    "notebooklm.google.com": "NotebookLM",
    "duck.ai": "DuckDuckGo AI",
    "duckduckgo.com": "DuckDuckGo AI",
  };

  const hostname = location.hostname.replace(/^www\./, "");
  const platform = PLATFORMS[hostname] || "Unknown AI";
  const isKnownPlatform = !!PLATFORMS[hostname];

  // ============================================================
  // Platform-specific selectors
  // ============================================================

  const SELECTORS = {
    ChatGPT: {
      chatContainer: "main",
      userMessage: '[data-message-author-role="user"]',
      aiMessage: '[data-message-author-role="assistant"]',
      inputArea: "#prompt-textarea",
      sendButton: '[data-testid="send-button"], button[aria-label="Send prompt"]',
      messageText: ".markdown, .whitespace-pre-wrap",
    },
    Claude: {
      chatContainer: '[class*="conversation"], main',
      userMessage: '[data-is-user-message="true"], .human-turn, [class*="human"]',
      aiMessage: '.ai-turn, [class*="assistant"], [class*="claude"]',
      inputArea: '[contenteditable="true"], .ProseMirror',
      sendButton: 'button[aria-label="Send"], button[type="submit"]',
      messageText: '.markdown, p, [class*="message-content"]',
    },
    Gemini: {
      chatContainer: "main, .chat-container",
      userMessage: '.query-text, [data-is-user] , message-content[class*="user"]',
      aiMessage: '.model-response-text, [data-is-model], message-content[class*="model"]',
      inputArea: ".ql-editor, rich-textarea, textarea",
      sendButton: 'button[aria-label="Send message"], .send-button',
      messageText: ".markdown-main-panel, .message-content, p",
    },
    Perplexity: {
      chatContainer: "main",
      userMessage: '[class*="query"], [class*="UserQuery"]',
      aiMessage: '[class*="answer"], [class*="Answer"], .prose',
      inputArea: "textarea",
      sendButton: 'button[aria-label="Submit"], button[type="submit"]',
      messageText: ".prose, p, .markdown",
    },
    DeepSeek: {
      chatContainer: "main, .chat-container",
      userMessage: '[class*="user-message"], [class*="human"]',
      aiMessage: '[class*="assistant-message"], [class*="bot"]',
      inputArea: "textarea, [contenteditable]",
      sendButton: 'button[class*="send"], button[type="submit"]',
      messageText: ".markdown, p",
    },
    Copilot: {
      chatContainer: "main, #chat-container",
      userMessage: '[class*="user-message"], [data-author="user"]',
      aiMessage: '[class*="bot-message"], [data-author="bot"]',
      inputArea: "textarea, #searchbox",
      sendButton: 'button[aria-label="Submit"], button[type="submit"]',
      messageText: ".ac-textBlock, p, .markdown",
    },
    "Meta AI": {
      chatContainer: "main",
      userMessage: '[class*="user"], [data-sender="user"]',
      aiMessage: '[class*="assistant"], [data-sender="assistant"]',
      inputArea: "textarea, [contenteditable]",
      sendButton: 'button[aria-label="Send"], button[type="submit"]',
      messageText: "p, .markdown, span",
    },
    Grok: {
      chatContainer: "main",
      userMessage: '[class*="user"], [data-role="user"]',
      aiMessage: '[class*="assistant"], [data-role="assistant"]',
      inputArea: "textarea, [contenteditable]",
      sendButton: 'button[aria-label="Send"], button[type="submit"]',
      messageText: ".markdown, p",
    },
    Poe: {
      chatContainer: "[class*='ChatMessagesView'], main",
      userMessage: "[class*='humanMessage'], [class*='Message_humanMessage']",
      aiMessage: "[class*='botMessage'], [class*='Message_botMessage']",
      inputArea: "textarea, [class*='TextArea']",
      sendButton: "button[class*='Send'], button[aria-label='Send']",
      messageText: ".markdown, .prose, p",
    },
    "You.com": {
      chatContainer: "main",
      userMessage: '[data-testid*="user"], [class*="user-message"]',
      aiMessage: '[data-testid*="assistant"], [class*="assistant"], .prose',
      inputArea: "textarea",
      sendButton: 'button[type="submit"], button[aria-label="Send"]',
      messageText: ".prose, .markdown, p",
    },
    HuggingChat: {
      chatContainer: "[class*='chat-container'], main",
      userMessage: "[class*='user'], .user-message",
      aiMessage: "[class*='assistant'], .assistant-message",
      inputArea: "textarea",
      sendButton: 'button[type="submit"]',
      messageText: ".prose, .markdown, p",
    },
    Mistral: {
      chatContainer: "main",
      userMessage: '[class*="user"], [data-role="user"]',
      aiMessage: '[class*="assistant"], [data-role="assistant"]',
      inputArea: "textarea",
      sendButton: 'button[type="submit"]',
      messageText: ".prose, .markdown, p",
    },
    Pi: {
      chatContainer: "main",
      userMessage: '[class*="human"], [class*="user"]',
      aiMessage: '[class*="bot"], [class*="ai"]',
      inputArea: "textarea, [contenteditable]",
      sendButton: 'button[type="submit"]',
      messageText: "p, span",
    },
    "Character.AI": {
      chatContainer: "#chat-messages, main, [class*='chat']",
      userMessage: '[class*="human"], [data-is-human], [class*="user"]',
      aiMessage: '[class*="char"], [data-is-bot], [class*="swipe"]',
      inputArea: "textarea",
      sendButton: 'button[type="submit"]',
      messageText: "p, .markdown",
    },
    "AI Studio": {
      chatContainer: "main",
      userMessage: '[class*="user"], [data-role="user"]',
      aiMessage: '[class*="model"], [data-role="model"]',
      inputArea: "textarea, [contenteditable]",
      sendButton: 'button[type="submit"], button[aria-label="Run"]',
      messageText: ".markdown, .prose, p",
    },
    NotebookLM: {
      chatContainer: "main",
      userMessage: '[class*="user"], [class*="query"]',
      aiMessage: '[class*="response"], [class*="answer"]',
      inputArea: "textarea, [contenteditable]",
      sendButton: 'button[type="submit"]',
      messageText: ".markdown, p",
    },
    "DuckDuckGo AI": {
      chatContainer: "main, .chat-container, [class*='chat']",
      userMessage: "[class*='user'], [data-role='user'], [class*='human'], .user-message",
      aiMessage: "[class*='assistant'], [data-role='assistant'], [class*='bot'], .response",
      inputArea: "textarea, [contenteditable='true']",
      sendButton: "button[type='submit'], button[aria-label='Send'], button[class*='send']",
      messageText: ".markdown, .prose, p",
    },
  };

  // Use platform-specific selectors, or a generic fallback for unknown AI sites
  const GENERIC_SELECTORS = {
    chatContainer: "main, [role='main'], #app",
    userMessage: '[class*="user"], [data-role="user"], [class*="human"]',
    aiMessage: '[class*="assistant"], [data-role="assistant"], [class*="bot"], [class*="ai"]',
    inputArea: 'textarea, [contenteditable="true"]',
    sendButton: 'button[type="submit"], button[aria-label="Send"]',
    messageText: ".markdown, .prose, p",
  };
  const sel = SELECTORS[platform] || GENERIC_SELECTORS;
  // For unknown platforms without selectors, use generic (don't bail out)

  // ============================================================
  // Fetch Interceptor — capture AI API responses in real-time
  // ============================================================

  const AI_API_PATTERNS = {
    ChatGPT: [/\/backend-api\/conversation/],
    Claude: [/\/api\/(organizations|chat_conversations|messages|completions)/],
    Gemini: [/\/batchexecute/],
    Perplexity: [/\/api\/(query|chat|search)/],
    DeepSeek: [/\/api\/(v0\/)?chat/],
    Copilot: [/\/(c\/api|sydney)\//],
    Poe: [/\/api\/(gql_POST|chat)/],
    "You.com": [/\/api\/(streamingSearch|chat)/],
    HuggingChat: [/\/conversation\//],
    Mistral: [/\/api\/chat/],
    Pi: [/\/api\/chat/],
    "Character.AI": [/\/(chat|turns)\//],
    "AI Studio": [/\/(generate|chat)/],
    NotebookLM: [/\/api\//],
    Grok: [/\/api\/rpc/],
    "Meta AI": [/\/api\/graphql/],
    "DuckDuckGo AI": [/\/duckchat\/v1\/chat/],
  };

  function isAIApiUrl(url) {
    const patterns = AI_API_PATTERNS[platform];
    if (!patterns) return false;
    return patterns.some(p => p.test(url));
  }

  function extractSSEText(jsonStr) {
    try {
      const json = JSON.parse(jsonStr);
      // ChatGPT: delta.content or message.content.parts[0]
      if (json.message?.content?.parts?.[0]) return json.message.content.parts[0];
      if (json.choices?.[0]?.delta?.content) return json.choices[0].delta.content;
      if (json.delta?.text) return json.delta.text;
      if (json.completion) return json.completion;
      if (json.delta?.content) return json.delta.content;
      // Claude streaming: content_block_delta
      if (json.type === "content_block_delta" && json.delta?.text) return json.delta.text;
      // Generic fallbacks
      if (typeof json.text === "string") return json.text;
      if (typeof json.content === "string") return json.content;
      if (typeof json.response === "string") return json.response;
      if (typeof json.answer === "string") return json.answer;
      if (typeof json.output === "string") return json.output;
    } catch {}
    return "";
  }

  async function processSSEStream(response, url) {
    try {
      if (!response.body) return;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let fullText = "";
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete lines
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]" || data === "") continue;

          const text = extractSSEText(data);
          if (text) fullText += text;
        }

        // Cap at 15KB
        if (fullText.length > 15000) {
          fullText = fullText.slice(0, 15000);
          break;
        }
      }

      if (fullText.length > 5) {
        captureResponse(fullText.trim());
      }
    } catch (e) {
      console.debug("[KyberGate] SSE processing error:", e);
    }
  }

  async function processJSONResponse(response, url) {
    try {
      const json = await response.json();
      let text = "";

      // Try common response structures
      if (json.message?.content?.parts) {
        text = json.message.content.parts.join("");
      } else if (json.choices?.[0]?.message?.content) {
        text = json.choices[0].message.content;
      } else if (json.completion) {
        text = json.completion;
      } else if (json.response) {
        text = typeof json.response === "string" ? json.response : JSON.stringify(json.response);
      } else if (json.answer) {
        text = json.answer;
      } else if (json.output) {
        text = typeof json.output === "string" ? json.output : JSON.stringify(json.output);
      }

      if (text && text.length > 5) {
        captureResponse(text.slice(0, 15000).trim());
      }
    } catch {}
  }

  // Hook fetch
  const _origFetch = window.fetch;
  window.fetch = async function(...args) {
    const response = await _origFetch.apply(this, args);

    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      if (isAIApiUrl(url)) {
        const ct = response.headers.get("content-type") || "";
        const clone = response.clone();

        if (ct.includes("text/event-stream") || ct.includes("octet-stream")) {
          processSSEStream(clone, url).catch(() => {});
        } else if (ct.includes("application/json")) {
          processJSONResponse(clone, url).catch(() => {});
        }
      }
    } catch {}

    return response;
  };

  // Also hook XMLHttpRequest for platforms that use it
  const _origXHROpen = XMLHttpRequest.prototype.open;
  const _origXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this._kyberUrl = url;
    this._kyberMethod = method;
    return _origXHROpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function(body) {
    if (this._kyberMethod === "POST" && isAIApiUrl(this._kyberUrl || "")) {
      this.addEventListener("load", function() {
        try {
          const text = this.responseText || "";
          if (text.length < 10 || text.length > 500000) return;

          // Check if SSE-style (multiple data: lines)
          if (text.includes("data: ")) {
            let fullText = "";
            for (const line of text.split("\n")) {
              if (!line.startsWith("data: ")) continue;
              const data = line.slice(6).trim();
              if (data === "[DONE]" || !data) continue;
              const extracted = extractSSEText(data);
              if (extracted) fullText += extracted;
            }
            if (fullText.length > 5) captureResponse(fullText.slice(0, 15000).trim());
          } else {
            // Try as JSON
            try {
              const json = JSON.parse(text);
              const extracted = json.choices?.[0]?.message?.content || json.completion || json.response || json.answer || "";
              if (typeof extracted === "string" && extracted.length > 5) {
                captureResponse(extracted.slice(0, 15000).trim());
              }
            } catch {}
          }
        } catch {}
      });
    }
    return _origXHRSend.call(this, body);
  };

  // ============================================================
  // State
  // ============================================================

  let lastPromptText = "";
  let lastPromptTime = 0;
  let capturedMessages = new Set(); // Track already-captured message nodes
  let conversationId = extractConversationId();
  let debounceTimer = null;
  const LOG_QUEUE = [];
  const RATE_LIMIT_MS = 5000; // 1 log per 5 seconds
  let lastLogTime = 0;

  // ============================================================
  // Safety Flagging
  // ============================================================

  const SAFETY_PATTERNS = {
    "academic-dishonesty": [
      /write\s+(my|this|an?)\s+(essay|paper|report|assignment|homework)/i,
      /do\s+(my|this)\s+(homework|assignment|project)/i,
      /complete\s+(my|this)\s+(assignment|worksheet|quiz)/i,
      /answer\s+(these|the|my)\s+(questions|problems)/i,
      /solve\s+(these|my|the)\s+(problems|equations|questions)/i,
      /paraphrase\s+this\s+(to\s+)?avoid\s+(plagiarism|detection)/i,
      /rewrite\s+(this|it)\s+(so|to)\s+(it\s+)?(doesn'?t|won'?t|not)\s+(look|seem|appear)\s+(like\s+)?(ai|chatgpt|generated|copied)/i,
      /make\s+(this|it)\s+(sound|look)\s+(more\s+)?(human|natural|original)/i,
      /bypass\s+(turnitin|plagiarism|ai\s*detect)/i,
    ],
    "self-harm": [
      /how\s+to\s+(kill|hurt|harm)\s+(myself|yourself)/i,
      /want\s+to\s+(die|end\s+(it|my\s+life))/i,
      /suicide\s+(method|way|how)/i,
      /self[\s-]?harm/i,
      /cutting\s+(myself|yourself)/i,
    ],
    "security-concern": [
      /how\s+to\s+hack/i,
      /bypass\s+(school\s+)?filter/i,
      /unblock\s+(websites?|games?)/i,
      /get\s+around\s+(the\s+)?(firewall|filter|block)/i,
      /disable\s+(the\s+)?(extension|filter|monitoring)/i,
      /remove\s+kybergate/i,
    ],
    inappropriate: [
      /\b(porn|hentai|nsfw|xxx|nude|naked)\b/i,
      /explicit\s+(content|material|story|image)/i,
      /sexual\s+(content|story|roleplay)/i,
      /write\s+(a\s+)?(sex|erotic|smut)/i,
    ],
  };

  function checkSafetyFlags(text) {
    if (!text || text.length < 10) return null;
    for (const [reason, patterns] of Object.entries(SAFETY_PATTERNS)) {
      for (const pat of patterns) {
        if (pat.test(text)) return reason;
      }
    }
    return null;
  }

  // ============================================================
  // Helpers
  // ============================================================

  function extractConversationId() {
    // Most AI chats have conversation ID in the URL path
    const path = location.pathname;
    // ChatGPT: /c/abc123 or /g/abc123
    const chatgptMatch = path.match(/\/[cg]\/([a-zA-Z0-9-]+)/);
    if (chatgptMatch) return chatgptMatch[1];
    // Claude: /chat/abc123
    const claudeMatch = path.match(/\/chat\/([a-zA-Z0-9-]+)/);
    if (claudeMatch) return claudeMatch[1];
    // Generic: last path segment that looks like an ID
    const segments = path.split("/").filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && last.length > 5 && /[a-zA-Z0-9-_]/.test(last)) return last;
    return "unknown-" + Date.now();
  }

  function getTextContent(el) {
    if (!el) return "";
    // Try to get clean text from markdown containers first
    const md = el.querySelector(sel.messageText);
    if (md) return md.innerText.trim();
    return el.innerText.trim();
  }

  function truncate(text, maxLen) {
    if (!text || text.length <= maxLen) return text;
    return text.substring(0, maxLen) + "…";
  }

  // ============================================================
  // Capture Logic
  // ============================================================

  function capturePrompt(text) {
    if (!text || text.length < 2) return;
    // Dedup — skip if same as last prompt within 10 seconds
    const now = Date.now();
    if (text === lastPromptText && now - lastPromptTime < 10000) return;
    lastPromptText = text;
    lastPromptTime = now;

    const flagReason = checkSafetyFlags(text);

    queueLog({
      type: "prompt",
      platform,
      promptText: truncate(text, 5000),
      responseText: "",
      promptLength: text.length,
      responseLength: 0,
      timestamp: new Date().toISOString(),
      url: location.href,
      conversationId,
      flagged: !!flagReason,
      flagReason: flagReason || null,
    });
  }

  function captureResponse(text) {
    if (!text || text.length < 5) return;

    queueLog({
      type: "response",
      platform,
      promptText: lastPromptText ? truncate(lastPromptText, 5000) : "",
      responseText: truncate(text, 10000),
      promptLength: lastPromptText ? lastPromptText.length : 0,
      responseLength: text.length,
      timestamp: new Date().toISOString(),
      url: location.href,
      conversationId,
      flagged: false,
      flagReason: null,
    });
  }

  // ============================================================
  // Log Queue — batch + rate-limit
  // ============================================================

  function queueLog(entry) {
    const now = Date.now();
    if (now - lastLogTime < RATE_LIMIT_MS) {
      // Rate limited — queue it
      LOG_QUEUE.push(entry);
      return;
    }
    lastLogTime = now;
    sendLog(entry);
  }

  function sendLog(entry) {
    try {
      chrome.runtime.sendMessage({
        type: "AI_CHAT_LOG",
        data: entry,
      });
    } catch (e) {
      // Extension context invalidated (update/reload)
      console.debug("[KyberGate] Failed to send AI chat log:", e);
    }
  }

  function flushQueue() {
    while (LOG_QUEUE.length > 0) {
      const entry = LOG_QUEUE.shift();
      sendLog(entry);
    }
  }

  // Flush queue every 30 seconds
  setInterval(flushQueue, 30000);

  // ============================================================
  // Input Capture — detect when user sends a prompt
  // ============================================================

  function setupInputCapture() {
    // Strategy 1: Listen for Enter key on the input area
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          const input = document.querySelector(sel.inputArea);
          if (input && (input === e.target || input.contains(e.target))) {
            const text = input.innerText || input.value || "";
            if (text.trim()) {
              // Small delay to let the message appear in the DOM
              setTimeout(() => capturePrompt(text.trim()), 100);
            }
          }
        }
      },
      true
    );

    // Strategy 2: Listen for send button clicks
    document.addEventListener(
      "click",
      (e) => {
        const btn = e.target.closest(sel.sendButton);
        if (btn) {
          const input = document.querySelector(sel.inputArea);
          if (input) {
            const text = input.innerText || input.value || "";
            if (text.trim()) {
              setTimeout(() => capturePrompt(text.trim()), 100);
            }
          }
        }
      },
      true
    );
  }

  // ============================================================
  // MutationObserver — detect new messages in chat
  // ============================================================

  let observer = null;

  function setupObserver() {
    if (observer) observer.disconnect();

    // Find the chat container
    const container =
      document.querySelector(sel.chatContainer) || document.body;

    let lastCharDataTime = 0;
    let lastMutationTime = 0;
    let stabilityTimer = null;
    let maxTimeoutTimer = null;
    let responseStartTime = 0;

    function checkStability() {
      const timeSinceLastChar = Date.now() - lastCharDataTime;
      const timeSinceLastMutation = Date.now() - lastMutationTime;

      if (timeSinceLastChar >= 2000 || timeSinceLastMutation >= 2000) {
        // Stable — capture response
        const aiMsgs = document.querySelectorAll(sel.aiMessage);
        if (aiMsgs.length > 0) {
          const lastAi = aiMsgs[aiMsgs.length - 1];
          if (!capturedMessages.has(lastAi)) {
            capturedMessages.add(lastAi);
            const text = getTextContent(lastAi);
            if (text) captureResponse(text);
          }
        }
        clearTimeout(maxTimeoutTimer);
        maxTimeoutTimer = null;
        responseStartTime = 0;
      } else {
        // Still streaming, check again in 1s
        stabilityTimer = setTimeout(checkStability, 1000);
      }
    }

    observer = new MutationObserver((mutations) => {
      const now = Date.now();
      lastMutationTime = now;

      // Check for character data changes (streaming text)
      if (mutations.some(m => m.type === "characterData" ||
        (m.type === "childList" && m.addedNodes.length > 0))) {
        lastCharDataTime = now;
      }

      // Check for new user messages
      const userMsgs = document.querySelectorAll(sel.userMessage);
      userMsgs.forEach((msg) => {
        if (!capturedMessages.has(msg)) {
          capturedMessages.add(msg);
          const text = getTextContent(msg);
          if (text) capturePrompt(text);
        }
      });

      // Smart stability detection for AI responses
      clearTimeout(stabilityTimer);
      stabilityTimer = setTimeout(checkStability, 2000);

      // Max timeout of 30 seconds — force capture if streaming runs too long
      if (!responseStartTime) {
        responseStartTime = now;
        maxTimeoutTimer = setTimeout(() => {
          clearTimeout(stabilityTimer);
          const aiMsgs = document.querySelectorAll(sel.aiMessage);
          if (aiMsgs.length > 0) {
            const lastAi = aiMsgs[aiMsgs.length - 1];
            if (!capturedMessages.has(lastAi)) {
              capturedMessages.add(lastAi);
              const text = getTextContent(lastAi);
              if (text) captureResponse(text);
            }
          }
          responseStartTime = 0;
        }, 30000);
      }
    });

    observer.observe(container, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  }

  // ============================================================
  // SPA Navigation Handler
  // ============================================================

  let lastUrl = location.href;

  function handleNavigation() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      conversationId = extractConversationId();
      capturedMessages.clear();
      lastPromptText = "";

      // Re-setup observer for new chat
      setTimeout(setupObserver, 1000);
    }
  }

  // Watch for SPA navigation (pushState/popstate)
  const originalPushState = history.pushState;
  history.pushState = function (...args) {
    originalPushState.apply(this, args);
    handleNavigation();
  };

  const originalReplaceState = history.replaceState;
  history.replaceState = function (...args) {
    originalReplaceState.apply(this, args);
    handleNavigation();
  };

  window.addEventListener("popstate", handleNavigation);

  // Also poll for URL changes (some SPAs don't use pushState)
  setInterval(handleNavigation, 2000);

  // ============================================================
  // Initialize
  // ============================================================

  function init() {
    setupInputCapture();
    // Wait for chat to render
    setTimeout(setupObserver, 2000);
    console.debug(`[KyberGate] AI Monitor active for ${platform}`);
  }

  // Start when DOM is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
