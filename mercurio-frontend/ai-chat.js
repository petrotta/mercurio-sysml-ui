import { resolveActiveEndpoint, sendChatMessage, sendEmbeddings } from "./ai.js";

const LLM_HINT_INDEX_KEY = "mercurio.llm.hints.v1";

function parseNewCommand(text) {
  const match = text.match(/^\/new\b[:\s-]*/i);
  if (!match) return null;
  const rest = text.slice(match[0].length);
  if (!rest.trim()) return null;
  const lines = rest.split("\n");
  let pathPart = lines.shift() || "";
  let content = lines.join("\n");
  if (!content) {
    const colonIndex = pathPart.indexOf(":");
    if (colonIndex !== -1) {
      content = pathPart.slice(colonIndex + 1);
      pathPart = pathPart.slice(0, colonIndex);
    }
  }
  const relPath = pathPart.trim().replace(/^["']|["']$/g, "");
  if (!relPath) return null;
  return { relPath, content: content.replace(/^\s*\n?/, "") };
}

function parseParseCommand(text) {
  const match = text.match(/^\/parse\b[:\s-]*/i);
  if (!match) return null;
  const rest = text.slice(match[0].length).trim();
  return { relPath: rest || "" };
}

function parseHintCommand(text) {
  const match = text.match(/^\/hint\b[:\s-]*/i);
  if (!match) return null;
  const rest = text.slice(match[0].length).trim();
  if (!rest) return { query: "" };
  if (/^rebuild\b/i.test(rest)) {
    return { query: "", rebuild: true };
  }
  return { query: rest || "" };
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length && i < b.length; i += 1) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function initAiChat(options) {
  const {
    invoke,
    elements,
    getState,
    getEditor,
    onEdit,
    onNew,
    onParse,
    setStatus: externalSetStatus,
  } = options;
  const { messagesEl, inputEl, statusEl, clearBtn, messageMenuEl } = elements;

  let llmInstructions = "";
  let llmHintIndex = null;
  let llmHintSeed = null;
  const inputHistory = [];
  let inputHistoryIndex = -1;
  let inputDraft = "";

  const setStatus = (text) => {
    if (statusEl) {
      statusEl.textContent = text || "";
    }
    externalSetStatus?.(text || "");
  };

  const renderMessage = (role, text) => {
    if (!messagesEl) return;
    const item = document.createElement("div");
    item.className = `ai-message ${role}`;
    if (role === "assistant") {
      item.appendChild(renderMarkdown(text || ""));
    } else {
      item.textContent = text;
    }
    messagesEl.appendChild(item);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  };

  const renderEditSummary = (path, editText) => {
    if (!messagesEl) return;
    const item = document.createElement("div");
    item.className = "ai-message assistant";
    const name = path ? path.split(/[\\/]/).pop() : "current file";
    const summary = document.createElement("span");
    summary.textContent = `Applied edit to ${name}.`;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "ai-edit-toggle";
    toggle.textContent = "Show edit";
    const details = document.createElement("pre");
    details.className = "ai-edit-details";
    details.textContent = editText || "";
    details.hidden = true;
    item.appendChild(summary);
    item.appendChild(toggle);
    item.appendChild(details);
    messagesEl.appendChild(item);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  };

  const renderNewSummary = (path, editText) => {
    if (!messagesEl) return;
    const item = document.createElement("div");
    item.className = "ai-message assistant";
    const name = path ? path.split(/[\\/]/).pop() : "new file";
    const summary = document.createElement("span");
    summary.textContent = `Created ${name}.`;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "ai-edit-toggle";
    toggle.textContent = "Show command";
    const details = document.createElement("pre");
    details.className = "ai-edit-details";
    details.textContent = editText || "";
    details.hidden = true;
    item.appendChild(summary);
    item.appendChild(toggle);
    item.appendChild(details);
    messagesEl.appendChild(item);
    messagesEl.scrollTop = messagesEl.scrollHeight;
  };

  const loadHintIndex = () => {
    if (llmHintIndex) return llmHintIndex;
    try {
      const raw = window.localStorage?.getItem(LLM_HINT_INDEX_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.items)) {
        llmHintIndex = parsed;
        return parsed;
      }
    } catch {}
    return null;
  };

  const saveHintIndex = (index) => {
    llmHintIndex = index;
    window.localStorage?.setItem(LLM_HINT_INDEX_KEY, JSON.stringify(index));
  };

  const ensureHintIndexFresh = async () => {
    let index = loadHintIndex();
    try {
      const meta = await invoke("get_llm_hints_meta");
      if (!meta || !meta.modified_ms) {
        return index;
      }
      if (!index || !index.sourceMtime || index.sourceMtime < meta.modified_ms) {
        index = await buildHintIndex(meta.modified_ms);
      }
    } catch (error) {
      invoke?.("log_frontend", { level: "WARN", kind: "hint", message: `meta check failed: ${error}` }).catch(() => {});
    }
    return index;
  };

  const ensureHintSeed = async () => {
    if (llmHintSeed) return llmHintSeed;
    try {
      const raw = await invoke("read_llm_hints");
      const parsed = JSON.parse(raw || "[]");
      llmHintSeed = Array.isArray(parsed) ? parsed : [];
    } catch {
      llmHintSeed = [];
      invoke?.("log_frontend", { level: "ERROR", kind: "hint", message: "read_llm_hints failed" }).catch(() => {});
    }
    return llmHintSeed;
  };

  const buildHintIndex = async (sourceMtime) => {
    const endpoint = resolveActiveEndpoint("embeddings");
    if (!endpoint) {
      setStatus("No embeddings endpoint configured.");
      invoke?.("log_frontend", { level: "WARN", kind: "hint", message: "rebuild blocked: no embeddings endpoint" }).catch(() => {});
      return null;
    }
    const seed = await ensureHintSeed();
    if (!seed.length) {
      setStatus("No hint corpus available.");
      invoke?.("log_frontend", { level: "WARN", kind: "hint", message: "rebuild blocked: no hint corpus" }).catch(() => {});
      return null;
    }
    const texts = seed.map((item) => item.text || "");
    let embeddings;
    try {
      embeddings = await sendEmbeddings(endpoint, texts);
    } catch (error) {
      setStatus(`Hint rebuild failed: ${error}`);
      invoke?.("log_frontend", { level: "ERROR", kind: "hint", message: `embedding failed: ${error}` }).catch(() => {});
      return null;
    }
    const items = seed.map((item, idx) => ({
      id: item.id || `hint-${idx}`,
      title: item.title || item.id || `Hint ${idx + 1}`,
      text: item.text || "",
      embedding: embeddings[idx] || [],
    }));
    const index = { items, createdAt: Date.now(), sourceMtime: sourceMtime || Date.now() };
    saveHintIndex(index);
    return index;
  };

  const searchHints = async (query, maxItems = 5) => {
    const endpoint = resolveActiveEndpoint("embeddings");
    if (!endpoint) {
      setStatus("No embeddings endpoint configured.");
      return [];
    }
    let index = await ensureHintIndexFresh();
    if (!index || !Array.isArray(index.items) || !index.items.length) {
      index = await buildHintIndex();
    }
    if (!index) return [];
    const [queryEmbedding] = await sendEmbeddings(endpoint, [query]);
    if (!queryEmbedding) return [];
    const scored = index.items.map((item) => ({
      item,
      score: cosineSimilarity(queryEmbedding, item.embedding || []),
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxItems).map((entry) => entry.item);
  };

  const buildChatMessages = (content, hintText = "") => {
    const history = Array.from(messagesEl.querySelectorAll(".ai-message")).map((node) => {
      const role = node.classList.contains("assistant") ? "assistant" : "user";
      return { role, content: node.textContent || "" };
    });
    const system = {
      role: "system",
      content:
        "You are the Mercurio assistant. You can edit the current open file with /edit and create new files inside the current project with /new <path>. Respond normally otherwise.",
    };
    const instructionMessage = llmInstructions
      ? { role: "system", content: llmInstructions }
      : null;
    const hintMessage = hintText ? { role: "system", content: hintText } : null;
    const state = getState();
    const editor = getEditor();
    if (state?.currentFile && editor) {
      const fileContent = editor.getValue();
      const pos = editor.getPosition();
      const cursorLine = pos ? pos.lineNumber : 1;
      const cursorCol = pos ? pos.column : 1;
      const context = `Current file: ${state.currentFile}\n\n${fileContent}`;
      const cursor = `Cursor position: line ${cursorLine}, column ${cursorCol}`;
      return [
        system,
        ...(instructionMessage ? [instructionMessage] : []),
        ...(hintMessage ? [hintMessage] : []),
        { role: "user", content: context },
        { role: "user", content: cursor },
        ...history,
        { role: "user", content },
      ];
    }
    return [
      system,
      ...(instructionMessage ? [instructionMessage] : []),
      ...(hintMessage ? [hintMessage] : []),
      ...history,
      { role: "user", content },
    ];
  };

  const renderMarkdown = (text) => {
    const container = document.createElement("div");
    container.className = "ai-markdown";
    const parts = String(text || "").split(/```/);
    parts.forEach((part, index) => {
      if (index % 2 === 1) {
        const codeLines = part.split("\n");
        if (codeLines.length && /^[a-zA-Z0-9_-]+$/.test(codeLines[0].trim())) {
          codeLines.shift();
        }
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        code.textContent = codeLines.join("\n");
        pre.appendChild(code);
        container.appendChild(pre);
        return;
      }
      renderMarkdownBlock(container, part);
    });
    return container;
  };

  const renderMarkdownBlock = (container, block) => {
    const lines = block.split("\n");
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) {
        i += 1;
        continue;
      }
      const headingMatch = line.match(/^(#{1,3})\s+(.*)$/);
      if (headingMatch) {
        const level = headingMatch[1].length;
        const heading = document.createElement(level === 1 ? "h3" : level === 2 ? "h4" : "h5");
        appendInline(heading, headingMatch[2]);
        container.appendChild(heading);
        i += 1;
        continue;
      }
      const listMatch = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
      if (listMatch) {
        const isOrdered = /^\d+\./.test(listMatch[2]);
        const list = document.createElement(isOrdered ? "ol" : "ul");
        while (i < lines.length) {
          const current = lines[i];
          const match = current.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
          if (!match) break;
          const item = document.createElement("li");
          appendInline(item, match[3]);
          list.appendChild(item);
          i += 1;
        }
        container.appendChild(list);
        continue;
      }
      const paragraph = document.createElement("p");
      appendInline(paragraph, line.trim());
      i += 1;
      while (i < lines.length && lines[i].trim()) {
        paragraph.appendChild(document.createTextNode(" "));
        appendInline(paragraph, lines[i].trim());
        i += 1;
      }
      container.appendChild(paragraph);
    }
  };

  const appendInline = (container, text) => {
    let remaining = String(text || "");
    while (remaining.length) {
      const codeIndex = remaining.indexOf("`");
      if (codeIndex === -1) {
        appendEmphasis(container, remaining);
        break;
      }
      if (codeIndex > 0) {
        appendEmphasis(container, remaining.slice(0, codeIndex));
      }
      const end = remaining.indexOf("`", codeIndex + 1);
      if (end === -1) {
        appendEmphasis(container, remaining.slice(codeIndex));
        break;
      }
      const code = document.createElement("code");
      code.textContent = remaining.slice(codeIndex + 1, end);
      container.appendChild(code);
      remaining = remaining.slice(end + 1);
    }
  };

  const appendEmphasis = (container, text) => {
    let remaining = text;
    while (remaining.length) {
      const boldMatch = remaining.match(/\*\*([^*]+)\*\*/);
      const italicMatch = remaining.match(/\*([^*]+)\*/);
      const nextMatch = selectNextMatch(boldMatch, italicMatch);
      if (!nextMatch) {
        container.appendChild(document.createTextNode(remaining));
        break;
      }
      const [matchText, content] = nextMatch.match;
      const start = nextMatch.index;
      if (start > 0) {
        container.appendChild(document.createTextNode(remaining.slice(0, start)));
      }
      const node = document.createElement(nextMatch.type === "bold" ? "strong" : "em");
      node.textContent = content;
      container.appendChild(node);
      remaining = remaining.slice(start + matchText.length);
    }
  };

  const selectNextMatch = (boldMatch, italicMatch) => {
    if (!boldMatch && !italicMatch) return null;
    if (boldMatch && (!italicMatch || boldMatch.index <= italicMatch.index)) {
      return { type: "bold", match: boldMatch, index: boldMatch.index };
    }
    return { type: "italic", match: italicMatch, index: italicMatch.index };
  };

  const handleMessage = async () => {
    if (!inputEl) return;
    const rawContent = inputEl.value;
    const content = rawContent.trim();
    if (!content) return;
    inputHistory.push(rawContent);
    inputHistoryIndex = -1;
    inputDraft = "";
    const normalized = content.replace(/^[\uFEFF\u200B]+/, "");
    const normalizedSlash = normalized.replace(/^[\uFF0F]/, "/");

    const hintCommand = parseHintCommand(normalizedSlash);
    if (hintCommand) {
      inputEl.value = "";
      renderMessage("user", content);
    if (hintCommand.rebuild) {
      try {
          const meta = await invoke("get_llm_hints_meta");
          const index = await buildHintIndex(meta?.modified_ms);
          renderMessage("assistant", index ? "Hint index rebuilt." : "Hint index rebuild failed.");
        } catch (error) {
          setStatus(`Hint rebuild failed: ${error}`);
          invoke?.("log_frontend", { level: "ERROR", kind: "hint", message: `rebuild failed: ${error}` }).catch(() => {});
        }
        return;
      }
      if (!hintCommand.query) {
        setStatus("Provide a hint query after /hint.");
        return;
      }
      try {
        const hints = await searchHints(hintCommand.query, 5);
        if (!hints.length) {
          renderMessage("assistant", "No hints found.");
        } else {
          const lines = hints.map(
            (hint, idx) => `${idx + 1}. ${hint.title}\n${hint.text.trim()}`
          );
          renderMessage("assistant", `Hints:\n${lines.join("\n\n")}`);
        }
      } catch (error) {
        setStatus(`Hint search failed: ${error}`);
      }
      return;
    }

    const parseCommand = parseParseCommand(normalizedSlash);
    if (parseCommand) {
      inputEl.value = "";
      renderMessage("user", content);
      const message = await onParse?.(parseCommand.relPath);
      if (message) {
        renderMessage("assistant", message);
      }
      return;
    }

    const newCommand = parseNewCommand(normalizedSlash);
    if (newCommand) {
      inputEl.value = "";
      renderMessage("user", content);
      const created = await onNew?.(newCommand.relPath, newCommand.content);
      if (created) {
        renderNewSummary(newCommand.relPath, normalizedSlash);
      }
      return;
    }

    const editMatch = normalizedSlash.match(/^\/edit\b[:\s-]*/i);
    if (editMatch) {
      inputEl.value = "";
      const instruction = normalizedSlash.slice(editMatch[0].length).trim();
      if (!instruction) {
        setStatus("Provide edit instructions after /edit.");
        return;
      }
      renderMessage("user", content);
      const applied = await onEdit?.(instruction);
      if (!applied) return;
      return;
    }

    const endpoint = resolveActiveEndpoint("chat");
    if (!endpoint) {
      setStatus("No chat endpoint configured.");
      return;
    }
    inputEl.value = "";
    renderMessage("user", content);
    setStatus("Sending...");
    try {
      let hintText = "";
      try {
        const hints = await searchHints(content, 3);
        if (hints.length) {
          const lines = hints.map((hint, idx) => `${idx + 1}. ${hint.title}\n${hint.text.trim()}`);
          hintText = `Relevant hints:\n${lines.join("\n\n")}`;
        }
      } catch {}
      const messages = buildChatMessages(content, hintText);
      const reply = await sendChatMessage(endpoint, messages);
      const replyText = reply || "(no response)";
      const normalizedReply = replyText.replace(/^[\uFEFF\u200B]+/, "").replace(/^[\uFF0F]/, "/");
      const replyNew = parseNewCommand(normalizedReply);
      if (replyNew) {
        const created = await onNew?.(replyNew.relPath, replyNew.content);
        if (created) {
          renderNewSummary(replyNew.relPath, normalizedReply);
        } else {
          renderMessage("assistant", replyText);
        }
      } else {
        const replyEdit = normalizedReply.match(/^\/edit\b[:\s-]*/i);
        if (replyEdit) {
          const instruction = normalizedReply.slice(replyEdit[0].length).trim();
          if (instruction) {
            const applied = await onEdit?.(instruction);
            if (applied) {
              renderEditSummary(getState()?.currentFile, normalizedReply);
            } else {
              renderMessage("assistant", replyText);
            }
          }
        } else {
          renderMessage("assistant", replyText);
        }
      }
      setStatus("");
    } catch (error) {
      setStatus(`AI error: ${error}`);
    }
  };

  const bind = () => {
    inputEl?.addEventListener("keydown", (event) => {
      if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key === "ArrowUp") {
        if (!inputHistory.length) return;
        event.preventDefault();
        if (inputHistoryIndex < 0) {
          inputDraft = inputEl.value;
          inputHistoryIndex = inputHistory.length;
        }
        inputHistoryIndex = Math.max(0, inputHistoryIndex - 1);
        inputEl.value = inputHistory[inputHistoryIndex] || "";
        inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
        return;
      }
      if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key === "ArrowDown") {
        if (inputHistoryIndex < 0) return;
        event.preventDefault();
        inputHistoryIndex = Math.min(inputHistory.length, inputHistoryIndex + 1);
        if (inputHistoryIndex >= inputHistory.length) {
          inputEl.value = inputDraft;
          inputHistoryIndex = -1;
        } else {
          inputEl.value = inputHistory[inputHistoryIndex] || "";
        }
        inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
        return;
      }
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        handleMessage();
      }
    });
    clearBtn?.addEventListener("click", () => {
      if (messagesEl) {
        messagesEl.innerHTML = "";
      }
      setStatus("");
    });
    messagesEl?.addEventListener("contextmenu", (event) => {
      const target = event.target.closest(".ai-message");
      if (!target || !messageMenuEl) return;
      event.preventDefault();
      messageMenuEl.dataset.text = target.textContent || "";
      messageMenuEl.hidden = false;
      const rect = messageMenuEl.getBoundingClientRect();
      const left = Math.min(event.clientX, window.innerWidth - rect.width - 8);
      const top = Math.min(event.clientY, window.innerHeight - rect.height - 8);
      messageMenuEl.style.left = `${Math.max(8, left)}px`;
      messageMenuEl.style.top = `${Math.max(8, top)}px`;
    });
    messagesEl?.addEventListener("click", (event) => {
      const toggle = event.target.closest(".ai-edit-toggle");
      if (!toggle) return;
      const message = toggle.closest(".ai-message");
      const details = message?.querySelector(".ai-edit-details");
      if (!details) return;
      details.hidden = !details.hidden;
      toggle.textContent = details.hidden ? "Show edit" : "Hide edit";
    });
    messageMenuEl?.addEventListener("click", async (event) => {
      const action = event.target?.dataset?.action;
      if (action === "copy") {
        const text = messageMenuEl?.dataset?.text || "";
        if (text && navigator.clipboard?.writeText) {
          try {
            await navigator.clipboard.writeText(text);
            setStatus("Copied message.");
          } catch {
            setStatus("Copy failed.");
          }
        }
      }
      if (messageMenuEl) {
        messageMenuEl.hidden = true;
        delete messageMenuEl.dataset.text;
      }
    });
    document.addEventListener("click", (event) => {
      if (!messageMenuEl || messageMenuEl.hidden) return;
      if (!event.target.closest("#ai-message-menu")) {
        messageMenuEl.hidden = true;
        delete messageMenuEl.dataset.text;
      }
    });
  };

  const loadInstructions = async () => {
    try {
      llmInstructions = await invoke("read_llm_instructions");
    } catch {
      llmInstructions = "";
    }
  };

  return {
    bind,
    loadInstructions,
    handleMessage,
    renderMessage,
  };
}
