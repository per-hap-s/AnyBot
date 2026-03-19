(function () {
    const UI_TEXT = {
        chat: {
            emptyTitle: "AnyBot 已就绪",
            emptySubtitle: "开始一段新对话，或先完成 Feishu 配置。",
            inputPlaceholder: "输入消息，Enter 发送，Shift + Enter 换行",
            sendButton: "发送",
            attachButtonTitle: "添加附件",
            attachmentOnly: "[附件]",
            typing: "正在生成回复...",
            uploadFailed: "附件上传失败",
            loadSessionFailed: "加载会话失败",
            sendFailed: "发送消息失败",
            initFailed: "界面初始化失败",
            uploadStatus: "上传中",
            removeAttachment: "移除附件",
            deleteSession: "删除",
            confirmDeleteSession: "确认删除",
            deleteSessionFailed: "删除会话失败",
        },
        role: {
            user: "用户",
            assistant: "助手",
        },
        feishu: {
            saveSuccess: "Feishu 配置已保存。",
            saveFailed: "保存 Feishu 配置失败",
        },
        telegram: {
            saveSuccess: "Telegram 配置已保存。",
            saveFailed: "保存 Telegram 配置失败",
        },
        proxy: {
            saveSuccess: "代理配置已保存。",
            saveFailed: "保存代理配置失败",
            testing: "正在测试代理连接...",
            testFailed: "代理测试失败",
            testSuccess: function (latency) {
                return "代理可用，延迟 " + latency + " ms";
            },
        },
        model: {
            switchFailed: "切换模型失败",
        },
    };

    const messagesEl = document.getElementById("messages");
    const historyListEl = document.getElementById("history-list");
    const inputEl = document.getElementById("chat-input");
    const sendBtn = document.getElementById("send-btn");
    const fileInput = document.getElementById("file-input");
    const attachBtn = document.getElementById("attach-btn");
    const attachmentPreviewEl = document.getElementById("attachment-preview");
    const modelSelectEl = document.getElementById("model-select");

    const views = {
        chat: document.getElementById("chat-view"),
        feishu: document.getElementById("feishu-view"),
        telegram: document.getElementById("telegram-view"),
        proxy: document.getElementById("proxy-view"),
    };

    const viewButtons = {
        chat: document.getElementById("chat-view-btn"),
        feishu: document.getElementById("feishu-view-btn"),
        telegram: document.getElementById("telegram-view-btn"),
        proxy: document.getElementById("proxy-view-btn"),
    };

    const feishuFields = {
        enabled: document.getElementById("feishu-enabled"),
        appId: document.getElementById("feishu-app-id"),
        appSecret: document.getElementById("feishu-app-secret"),
        groupChatMode: document.getElementById("feishu-group-mode"),
        botOpenId: document.getElementById("feishu-bot-open-id"),
        ackReaction: document.getElementById("feishu-ack-reaction"),
        ownerChatId: document.getElementById("feishu-owner-chat-id"),
        status: document.getElementById("feishu-status"),
        saveBtn: document.getElementById("save-feishu-btn"),
    };

    const telegramFields = {
        enabled: document.getElementById("telegram-enabled"),
        botToken: document.getElementById("telegram-bot-token"),
        ownerChatId: document.getElementById("telegram-owner-chat-id"),
        privateOnly: document.getElementById("telegram-private-only"),
        allowGroups: document.getElementById("telegram-allow-groups"),
        pollingTimeoutSeconds: document.getElementById("telegram-polling-timeout"),
        finalReplyMode: document.getElementById("telegram-final-reply-mode"),
        status: document.getElementById("telegram-status"),
        saveBtn: document.getElementById("save-telegram-btn"),
    };

    const proxyFields = {
        enabled: document.getElementById("proxy-enabled"),
        protocol: document.getElementById("proxy-protocol"),
        host: document.getElementById("proxy-host"),
        port: document.getElementById("proxy-port"),
        username: document.getElementById("proxy-username"),
        password: document.getElementById("proxy-password"),
        status: document.getElementById("proxy-status"),
        saveBtn: document.getElementById("save-proxy-btn"),
        testBtn: document.getElementById("test-proxy-btn"),
    };

    const IMAGE_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".svg", ".ico", ".tiff", ".tif", ".heic", ".heif", ".avif"];

    let sessions = [];
    let currentSessionId = null;
    let pendingAttachments = [];
    let pendingDeleteSessionId = null;
    let deletingSessionId = null;
    let isSending = false;

    inputEl.placeholder = UI_TEXT.chat.inputPlaceholder;
    sendBtn.textContent = UI_TEXT.chat.sendButton;
    attachBtn.title = UI_TEXT.chat.attachButtonTitle;
    attachBtn.setAttribute("aria-label", UI_TEXT.chat.attachButtonTitle);

    function escapeHtml(text) {
        return String(text)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }

    function getRoleLabel(role) {
        return UI_TEXT.role[role] || role;
    }

    function createEmptyStateHtml() {
        return '<div class="empty-state">' +
            '<div class="empty-title">' + escapeHtml(UI_TEXT.chat.emptyTitle) + "</div>" +
            '<div class="empty-subtitle">' + escapeHtml(UI_TEXT.chat.emptySubtitle) + "</div>" +
            "</div>";
    }

    function resetPendingDelete() {
        pendingDeleteSessionId = null;
    }

    function resetComposerState() {
        inputEl.value = "";
        inputEl.style.height = "auto";
        pendingAttachments = [];
        renderAttachmentPreview();
        updateSendButton();
    }

    function clearCurrentChatView() {
        currentSessionId = null;
        resetComposerState();
        renderMessages([]);
        renderHistory();
        setView("chat");
    }

    function setView(viewName) {
        Object.keys(views).forEach(function (name) {
            const active = name === viewName;
            views[name].classList.toggle("active", active);
            viewButtons[name].classList.toggle("active", active);
        });
    }

    function setStatus(el, text, isError) {
        el.textContent = text;
        el.classList.toggle("error", Boolean(isError));
    }

    function updateSendButton() {
        const hasContent = inputEl.value.trim() || pendingAttachments.length > 0;
        sendBtn.disabled = !hasContent || isSending;
    }

    function formatBytes(bytes) {
        if (bytes < 1024) return bytes + " B";
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
        return (bytes / (1024 * 1024)).toFixed(1) + " MB";
    }

    function renderAttachmentPreview() {
        attachmentPreviewEl.innerHTML = "";
        pendingAttachments.forEach(function (attachment, index) {
            const item = document.createElement("div");
            item.className = "attachment-item";
            item.innerHTML =
                '<div class="attachment-main">' +
                '<div class="attachment-name">' + escapeHtml(attachment.name) + "</div>" +
                '<div class="attachment-meta">' + escapeHtml(formatBytes(attachment.size) + (attachment.uploading ? " · " + UI_TEXT.chat.uploadStatus : "")) + "</div>" +
                "</div>";

            if (!attachment.uploading) {
                const removeBtn = document.createElement("button");
                removeBtn.type = "button";
                removeBtn.className = "attachment-remove";
                removeBtn.textContent = UI_TEXT.chat.removeAttachment;
                removeBtn.setAttribute("aria-label", UI_TEXT.chat.removeAttachment);
                removeBtn.addEventListener("click", function () {
                    pendingAttachments.splice(index, 1);
                    renderAttachmentPreview();
                    updateSendButton();
                });
                item.appendChild(removeBtn);
            }

            attachmentPreviewEl.appendChild(item);
        });
    }

    async function uploadFile(file) {
        const attachment = {
            name: file.name,
            size: file.size,
            isImage: IMAGE_EXTS.some(function (ext) {
                return file.name.toLowerCase().endsWith(ext);
            }),
            path: "",
            uploading: true,
        };
        pendingAttachments.push(attachment);
        renderAttachmentPreview();
        updateSendButton();

        try {
            const formData = new FormData();
            formData.append("file", file);
            const res = await fetch("/api/upload", { method: "POST", body: formData });
            if (!res.ok) {
                throw new Error(UI_TEXT.chat.uploadFailed);
            }
            const data = await res.json();
            attachment.path = data.path;
            attachment.uploading = false;
            renderAttachmentPreview();
            updateSendButton();
        } catch (error) {
            pendingAttachments = pendingAttachments.filter(function (item) {
                return item !== attachment;
            });
            renderAttachmentPreview();
            updateSendButton();
            alert(error instanceof Error ? error.message : UI_TEXT.chat.uploadFailed);
        }
    }

    function renderMessages(messages) {
        if (!messages || messages.length === 0) {
            messagesEl.innerHTML = createEmptyStateHtml();
            return;
        }

        messagesEl.innerHTML = "";
        messages.forEach(function (message) {
            messagesEl.appendChild(createMessageRow(message.role, message.content));
        });
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function createMessageRow(role, content) {
        const row = document.createElement("div");
        row.className = "message-row " + role;
        row.innerHTML =
            '<div class="message-card">' +
            '<div class="message-role">' + escapeHtml(getRoleLabel(role)) + "</div>" +
            '<pre class="message-text">' + escapeHtml(content) + "</pre>" +
            "</div>";
        return row;
    }

    function ensureMessageListVisible() {
        if (messagesEl.querySelector(".empty-state")) {
            messagesEl.innerHTML = "";
        }
    }

    function appendMessage(role, content) {
        ensureMessageListVisible();
        const row = createMessageRow(role, content);
        messagesEl.appendChild(row);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        return row;
    }

    function snapshotRenderedMessages() {
        if (messagesEl.querySelector(".empty-state")) {
            return [];
        }

        return Array.from(messagesEl.querySelectorAll(".message-row")).map(function (row) {
            return {
                role: row.classList.contains("user") ? "user" : "assistant",
                content: row.querySelector(".message-text").textContent || "",
            };
        });
    }

    function renderHistory() {
        historyListEl.innerHTML = "";

        sessions.forEach(function (session) {
            const row = document.createElement("div");
            row.className = "history-row";

            const item = document.createElement("button");
            item.type = "button";
            item.className = "history-item" + (session.id === currentSessionId ? " active" : "");
            item.textContent = session.title;
            item.title = session.title;
            item.addEventListener("click", function () {
                resetPendingDelete();
                loadSession(session.id);
            });

            const deleteBtn = document.createElement("button");
            deleteBtn.type = "button";
            deleteBtn.className = "history-delete-btn";
            if (session.id === pendingDeleteSessionId) {
                deleteBtn.classList.add("confirm");
            }
            if (session.id === deletingSessionId) {
                deleteBtn.disabled = true;
            }
            deleteBtn.textContent = session.id === pendingDeleteSessionId
                ? UI_TEXT.chat.confirmDeleteSession
                : UI_TEXT.chat.deleteSession;
            deleteBtn.setAttribute("aria-label", deleteBtn.textContent);
            deleteBtn.addEventListener("click", function (event) {
                event.stopPropagation();

                if (deletingSessionId) {
                    return;
                }

                if (pendingDeleteSessionId !== session.id) {
                    pendingDeleteSessionId = session.id;
                    renderHistory();
                    return;
                }

                deleteSession(session.id);
            });

            row.appendChild(item);
            row.appendChild(deleteBtn);
            historyListEl.appendChild(row);
        });
    }

    async function fetchSessions() {
        const res = await fetch("/api/sessions");
        sessions = await res.json();
        if (!sessions.some(function (session) { return session.id === pendingDeleteSessionId; })) {
            pendingDeleteSessionId = null;
        }
        renderHistory();
    }

    async function createNewChat() {
        const res = await fetch("/api/sessions", { method: "POST" });
        const data = await res.json();
        currentSessionId = data.id;
        resetPendingDelete();
        resetComposerState();
        renderMessages([]);
        setView("chat");
        await fetchSessions();
    }

    async function loadSession(id) {
        const res = await fetch("/api/sessions/" + id);
        if (!res.ok) {
            alert(UI_TEXT.chat.loadSessionFailed);
            return;
        }

        const session = await res.json();
        resetPendingDelete();
        currentSessionId = session.id;
        renderMessages(session.messages);
        renderHistory();
        setView("chat");
    }

    async function deleteSession(sessionId) {
        deletingSessionId = sessionId;
        renderHistory();

        try {
            const res = await fetch("/api/sessions/" + sessionId, {
                method: "DELETE",
            });
            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.error || UI_TEXT.chat.deleteSessionFailed);
            }

            pendingDeleteSessionId = null;

            if (currentSessionId === sessionId) {
                sessions = sessions.filter(function (session) {
                    return session.id !== sessionId;
                });
                clearCurrentChatView();
                return;
            }

            await fetchSessions();
        } catch (error) {
            pendingDeleteSessionId = null;
            renderHistory();
            alert(error instanceof Error ? error.message : UI_TEXT.chat.deleteSessionFailed);
        } finally {
            deletingSessionId = null;
            renderHistory();
        }
    }

    function renderTyping(initialText) {
        clearTyping();
        const row = appendMessage("assistant", initialText || UI_TEXT.chat.typing);
        row.id = "typing-indicator";
        return row;
    }

    function setTypingText(text) {
        const typing = document.getElementById("typing-indicator");
        if (!typing) {
            return;
        }

        const textEl = typing.querySelector(".message-text");
        if (textEl) {
            textEl.textContent = text;
        }
        messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    function clearTyping() {
        const typing = document.getElementById("typing-indicator");
        if (typing) {
            typing.remove();
        }
    }

    async function parseErrorResponse(response) {
        const text = await response.text();
        try {
            const data = JSON.parse(text);
            return data.error || UI_TEXT.chat.sendFailed;
        } catch (_error) {
            return text || UI_TEXT.chat.sendFailed;
        }
    }

    async function consumeNdjsonStream(response, handlers) {
        const reader = response.body && response.body.getReader ? response.body.getReader() : null;
        if (!reader) {
            throw new Error("当前环境不支持流式响应读取");
        }

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
            const result = await reader.read();
            if (result.done) {
                break;
            }

            buffer += decoder.decode(result.value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            lines.forEach(function (line) {
                const trimmed = line.trim();
                if (!trimmed) {
                    return;
                }

                const event = JSON.parse(trimmed);
                handlers.onEvent(event);
            });
        }

        const tail = buffer.trim();
        if (tail) {
            handlers.onEvent(JSON.parse(tail));
        }
    }

    async function sendMessage() {
        if (!currentSessionId) {
            await createNewChat();
        }

        const content = inputEl.value.trim();
        const attachments = pendingAttachments.filter(function (item) {
            return !item.uploading;
        }).map(function (item) {
            return { path: item.path, name: item.name };
        });

        if (!content && attachments.length === 0) {
            return;
        }

        isSending = true;
        updateSendButton();

        try {
            const nextMessages = snapshotRenderedMessages();
            nextMessages.push({ role: "user", content: content || UI_TEXT.chat.attachmentOnly });
            renderMessages(nextMessages);

            inputEl.value = "";
            inputEl.style.height = "auto";
            pendingAttachments = [];
            renderAttachmentPreview();
            renderTyping("正在准备请求...");

            const sessionId = currentSessionId;
            let assistantContent = "";
            const res = await fetch("/api/sessions/" + sessionId + "/messages/stream", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ content: content, attachments: attachments }),
            });

            if (!res.ok) {
                throw new Error(await parseErrorResponse(res));
            }

            await consumeNdjsonStream(res, {
                onEvent: function (event) {
                    if (event.type === "status") {
                        setTypingText(event.message || UI_TEXT.chat.typing);
                        return;
                    }

                    if (event.type === "assistant") {
                        assistantContent = event.content || "";
                        setTypingText(assistantContent || UI_TEXT.chat.typing);
                        const typing = document.getElementById("typing-indicator");
                        if (typing) {
                            typing.removeAttribute("id");
                        }
                        return;
                    }

                    if (event.type === "error") {
                        throw new Error(event.error || UI_TEXT.chat.sendFailed);
                    }
                },
            });

            if (!assistantContent) {
                clearTyping();
            }

            await loadSession(sessionId);
            await fetchSessions();
        } catch (error) {
            clearTyping();
            alert(error instanceof Error ? error.message : UI_TEXT.chat.sendFailed);
        } finally {
            isSending = false;
            updateSendButton();
        }
    }

    async function fetchModelConfig() {
        const res = await fetch("/api/model-config");
        const config = await res.json();
        modelSelectEl.innerHTML = "";
        config.models.forEach(function (model) {
            const option = document.createElement("option");
            option.value = model.id;
            option.textContent = model.name + " (" + model.id + ")";
            option.selected = model.id === config.currentModel;
            modelSelectEl.appendChild(option);
        });
    }

    async function saveModel() {
        const modelId = modelSelectEl.value;
        const res = await fetch("/api/model-config", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ modelId: modelId }),
        });
        const data = await res.json();
        if (!res.ok) {
            alert(data.error || UI_TEXT.model.switchFailed);
            await fetchModelConfig();
            return;
        }
        await fetchModelConfig();
    }

    async function fetchFeishuConfig() {
        const res = await fetch("/api/channels");
        const data = await res.json();
        const config = data.config.feishu || {};
        feishuFields.enabled.checked = Boolean(config.enabled);
        feishuFields.appId.value = config.appId || "";
        feishuFields.appSecret.value = config.appSecret || "";
        feishuFields.groupChatMode.value = config.groupChatMode || "mention";
        feishuFields.botOpenId.value = config.botOpenId || "";
        feishuFields.ackReaction.value = config.ackReaction || "OK";
        feishuFields.ownerChatId.value = config.ownerChatId || "";
        setStatus(feishuFields.status, "", false);
    }

    async function saveFeishuConfig() {
        const payload = {
            enabled: feishuFields.enabled.checked,
            appId: feishuFields.appId.value.trim(),
            appSecret: feishuFields.appSecret.value.trim(),
            groupChatMode: feishuFields.groupChatMode.value,
            botOpenId: feishuFields.botOpenId.value.trim(),
            ackReaction: feishuFields.ackReaction.value.trim(),
            ownerChatId: feishuFields.ownerChatId.value.trim(),
        };

        const res = await fetch("/api/channels/feishu", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) {
            setStatus(feishuFields.status, data.error || UI_TEXT.feishu.saveFailed, true);
            return;
        }
        setStatus(feishuFields.status, UI_TEXT.feishu.saveSuccess, false);
    }

    async function fetchTelegramConfig() {
        const res = await fetch("/api/channels");
        const data = await res.json();
        const config = data.config.telegram || {};
        telegramFields.enabled.checked = Boolean(config.enabled);
        telegramFields.botToken.value = config.botToken || "";
        telegramFields.ownerChatId.value = config.ownerChatId || "";
        telegramFields.privateOnly.checked = typeof config.privateOnly === "boolean"
            ? config.privateOnly
            : true;
        telegramFields.allowGroups.checked = Boolean(config.allowGroups);
        telegramFields.pollingTimeoutSeconds.value = config.pollingTimeoutSeconds || 30;
        telegramFields.finalReplyMode.value = config.finalReplyMode === "replace_and_notify"
            ? "replace_and_notify"
            : "replace";
        setStatus(telegramFields.status, "", false);
    }

    async function saveTelegramConfig() {
        const payload = {
            enabled: telegramFields.enabled.checked,
            botToken: telegramFields.botToken.value.trim(),
            ownerChatId: telegramFields.ownerChatId.value.trim(),
            privateOnly: telegramFields.privateOnly.checked,
            allowGroups: telegramFields.allowGroups.checked,
            pollingTimeoutSeconds: Number(telegramFields.pollingTimeoutSeconds.value) || 30,
            finalReplyMode: telegramFields.finalReplyMode.value === "replace_and_notify"
                ? "replace_and_notify"
                : "replace",
        };

        const res = await fetch("/api/channels/telegram", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) {
            setStatus(telegramFields.status, data.error || UI_TEXT.telegram.saveFailed, true);
            return;
        }
        setStatus(telegramFields.status, UI_TEXT.telegram.saveSuccess, false);
    }

    async function fetchProxyConfig() {
        const res = await fetch("/api/proxy");
        const config = await res.json();
        proxyFields.enabled.checked = Boolean(config.enabled);
        proxyFields.protocol.value = config.protocol || "http";
        proxyFields.host.value = config.host || "";
        proxyFields.port.value = config.port || 7890;
        proxyFields.username.value = config.username || "";
        proxyFields.password.value = config.password || "";
        setStatus(proxyFields.status, "", false);
    }

    function getProxyPayload() {
        return {
            enabled: proxyFields.enabled.checked,
            protocol: proxyFields.protocol.value,
            host: proxyFields.host.value.trim(),
            port: Number(proxyFields.port.value),
            username: proxyFields.username.value.trim(),
            password: proxyFields.password.value,
        };
    }

    async function saveProxyConfig() {
        const res = await fetch("/api/proxy", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(getProxyPayload()),
        });
        const data = await res.json();
        if (!res.ok) {
            setStatus(proxyFields.status, data.error || UI_TEXT.proxy.saveFailed, true);
            return;
        }
        setStatus(proxyFields.status, UI_TEXT.proxy.saveSuccess, false);
    }

    async function testProxyConfig() {
        setStatus(proxyFields.status, UI_TEXT.proxy.testing, false);
        const res = await fetch("/api/proxy/test", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(getProxyPayload()),
        });
        const data = await res.json();
        if (!data.ok) {
            setStatus(proxyFields.status, data.error || UI_TEXT.proxy.testFailed, true);
            return;
        }
        setStatus(proxyFields.status, UI_TEXT.proxy.testSuccess(data.latency), false);
    }

    document.getElementById("new-chat-btn").addEventListener("click", createNewChat);
    viewButtons.chat.addEventListener("click", function () {
        resetPendingDelete();
        setView("chat");
        renderHistory();
    });
    viewButtons.feishu.addEventListener("click", function () {
        resetPendingDelete();
        setView("feishu");
        renderHistory();
    });
    viewButtons.telegram.addEventListener("click", function () {
        resetPendingDelete();
        setView("telegram");
        renderHistory();
    });
    viewButtons.proxy.addEventListener("click", function () {
        resetPendingDelete();
        setView("proxy");
        renderHistory();
    });

    sendBtn.addEventListener("click", sendMessage);
    inputEl.addEventListener("input", function () {
        inputEl.style.height = "auto";
        inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + "px";
        updateSendButton();
    });
    inputEl.addEventListener("keydown", function (event) {
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            if (!sendBtn.disabled) {
                sendMessage();
            }
        }
    });

    attachBtn.addEventListener("click", function () {
        fileInput.click();
    });
    fileInput.addEventListener("change", function () {
        Array.from(fileInput.files || []).forEach(uploadFile);
        fileInput.value = "";
    });

    modelSelectEl.addEventListener("change", saveModel);
    feishuFields.saveBtn.addEventListener("click", saveFeishuConfig);
    telegramFields.saveBtn.addEventListener("click", saveTelegramConfig);
    proxyFields.saveBtn.addEventListener("click", saveProxyConfig);
    proxyFields.testBtn.addEventListener("click", testProxyConfig);

    async function init() {
        await Promise.all([
            fetchSessions(),
            fetchModelConfig(),
            fetchFeishuConfig(),
            fetchTelegramConfig(),
            fetchProxyConfig(),
        ]);

        if (sessions.length > 0) {
            await loadSession(sessions[0].id);
        } else {
            await createNewChat();
        }
    }

    init().catch(function (error) {
        alert(error instanceof Error ? error.message : UI_TEXT.chat.initFailed);
    });
})();
