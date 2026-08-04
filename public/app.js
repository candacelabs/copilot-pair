const transcript = document.querySelector("#transcript");
const streaming = document.querySelector("#streaming");
const pending = document.querySelector("#pending");
const connectionDot = document.querySelector("#connection-dot");
const connectionLabel = document.querySelector("#connection-label");
const sessionIdLabel = document.querySelector("#session-id");
const peerCount = document.querySelector("#peer-count");
const eventCount = document.querySelector("#event-count");
const actorInput = document.querySelector("#actor");
const modelInput = document.querySelector("#model");
const promptInput = document.querySelector("#prompt");
const statusLabel = document.querySelector("#action-status");

const state = {
  events: new Map(),
  permissionRequests: new Map(),
  userInputRequests: new Map(),
  planRequests: new Map(),
  streams: new Map(),
  toolNames: new Map(),
  activeStreamId: undefined,
  sessionId: undefined,
};

actorInput.value = localStorage.getItem("candace-pair-actor") || "Guest";
actorInput.addEventListener("change", () => {
  localStorage.setItem("candace-pair-actor", actorInput.value.trim() || "Guest");
});

document.querySelector("#send").addEventListener("click", () => sendPrompt("enqueue"));
document.querySelector("#steer").addEventListener("click", () => sendPrompt("immediate"));
document.querySelector("#abort").addEventListener("click", () => runAction({ type: "abort" }, "Stopping…"));
document.querySelector("#change-model").addEventListener("click", () => {
  const model = modelInput.value.trim();
  if (model) {
    void runAction({ type: "model", model }, `Switching to ${model}…`);
  }
});
promptInput.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    void sendPrompt(event.altKey ? "immediate" : "enqueue");
  }
});

connect();

function connect() {
  setConnection("connecting", "Connecting");
  const source = new EventSource("/api/events");
  source.addEventListener("open", () => setConnection("live", "Live"));
  source.addEventListener("error", () => setConnection("error", "Reconnecting"));
  source.addEventListener("snapshot", (message) => {
    const snapshot = JSON.parse(message.data);
    state.sessionId = snapshot.sessionId;
    sessionIdLabel.textContent = shortId(snapshot.sessionId);
    const storedReplica = mergeStoredReplica();
    for (const event of snapshot.durableEvents ?? []) {
      mergeEvent(event, true);
    }
    persistReplica();
    render();
    void publishReplica(storedReplica);
  });
  source.addEventListener("session-event", (message) => {
    const payload = JSON.parse(message.data);
    mergeEvent(payload.event, payload.durable);
    if (payload.durable) {
      persistReplicaSoon();
    }
    render();
  });
  source.addEventListener("presence", (message) => {
    peerCount.textContent = JSON.parse(message.data).connectedClients ?? 0;
  });
  source.addEventListener("share-stopped", () => {
    source.close();
    setConnection("error", "Share stopped");
    disableControls(true);
  });
}

function mergeEvent(event, durable) {
  if (!event || typeof event.id !== "string") {
    return;
  }
  if (durable && !state.events.has(event.id)) {
    state.events.set(event.id, event);
  }

  const requestId = event.data?.requestId;
  switch (event.type) {
    case "assistant.message_delta": {
      const messageId = event.data?.messageId || "active";
      state.activeStreamId = messageId;
      state.streams.set(
        messageId,
        (state.streams.get(messageId) || "") + (event.data?.deltaContent ?? ""),
      );
      break;
    }
    case "assistant.message": {
      const messageId = event.data?.messageId;
      if (messageId) state.streams.delete(messageId);
      if (!messageId || state.activeStreamId === messageId) state.activeStreamId = undefined;
      break;
    }
    case "session.idle":
      state.streams.clear();
      state.activeStreamId = undefined;
      break;
    case "tool.execution_start":
      if (event.data?.toolCallId) {
        state.toolNames.set(event.data.toolCallId, event.data.toolName || "unknown");
      }
      break;
    case "permission.requested":
      if (requestId) {
        state.permissionRequests.set(requestId, event);
      }
      break;
    case "permission.completed":
      state.permissionRequests.delete(requestId);
      break;
    case "user_input.requested":
      if (requestId) state.userInputRequests.set(requestId, event);
      break;
    case "user_input.completed":
      state.userInputRequests.delete(requestId);
      break;
    case "exit_plan_mode.requested":
      if (requestId) state.planRequests.set(requestId, event);
      break;
    case "exit_plan_mode.completed":
      state.planRequests.delete(requestId);
      break;
  }
}

function render() {
  const events = [...state.events.values()].sort(compareEvents).filter(isVisibleEvent);
  transcript.replaceChildren();
  if (events.length === 0) {
    transcript.append(document.querySelector("#empty-template").content.cloneNode(true));
  } else {
    for (const event of events) transcript.append(renderEvent(event));
  }
  eventCount.textContent = state.events.size;

  const streamText = currentStreamText();
  const streamPre = streaming.querySelector("pre");
  streamPre.textContent = streamText;
  streaming.hidden = !streamText;
  renderPendingRequests();
  if (streamText) streaming.scrollIntoView({ block: "nearest" });
}

function renderEvent(event) {
  const article = document.createElement("article");
  const label = document.createElement("p");
  const body = document.createElement("pre");
  article.className = "message";
  label.className = "message-label";

  switch (event.type) {
    case "user.message":
      article.classList.add("user");
      label.textContent = "Shared prompt";
      body.textContent = textValue(event.data?.content);
      break;
    case "assistant.message":
      article.classList.add("assistant");
      label.textContent = "Copilot";
      body.textContent = textValue(event.data?.content);
      break;
    case "tool.execution_start":
      article.classList.add("tool");
      label.textContent = `Tool started · ${event.data?.toolName ?? "unknown"}`;
      body.textContent = compactValue(event.data?.arguments);
      break;
    case "tool.execution_complete":
      article.classList.add("tool");
      label.textContent = `${event.data?.success === false ? "Tool failed" : "Tool finished"} · ${state.toolNames.get(event.data?.toolCallId) ?? "unknown"}`;
      body.textContent = compactValue(
        event.data?.error?.message
          ?? event.data?.result?.detailedContent
          ?? event.data?.result?.content
          ?? event.data?.error
          ?? event.data?.result,
      );
      break;
    case "session.error":
      article.classList.add("error");
      label.textContent = "Session error";
      body.textContent = event.data?.message ?? compactValue(event.data);
      break;
    default:
      article.classList.add("tool");
      label.textContent = event.type.replaceAll(".", " · ");
      body.textContent = compactValue(event.data);
  }

  article.append(label, body);
  return article;
}

function renderPendingRequests() {
  pending.replaceChildren();
  for (const event of state.permissionRequests.values()) {
    pending.append(permissionCard(event));
  }
  for (const event of state.userInputRequests.values()) {
    pending.append(userInputCard(event));
  }
  for (const event of state.planRequests.values()) {
    pending.append(planCard(event));
  }
}

function permissionCard(event) {
  const card = requestCard("Copilot needs permission", describePermission(event.data));
  const actions = document.createElement("div");
  actions.className = "request-actions";
  actions.append(
    actionButton("Deny", "danger", () => runAction({
      type: "permission",
      requestId: event.data.requestId,
      decision: "deny",
    }, "Denying…")),
    actionButton("Approve once", "primary", () => runAction({
      type: "permission",
      requestId: event.data.requestId,
      decision: "approve",
    }, "Approving…")),
  );
  card.append(actions);
  return card;
}

function userInputCard(event) {
  const choices = (event.data.choices ?? []).join(" · ");
  return requestCard(
    "Copilot has a question",
    [event.data.question ?? "Answer required", choices, "Answer this in the owner CLI."].filter(Boolean).join("\n\n"),
  );
}

function planCard(event) {
  return requestCard(
    event.data.summary || "Copilot has a plan",
    `${event.data.planContent || "Plan review required."}\n\nApprove or revise this plan in the owner CLI.`,
  );
}

function requestCard(title, text) {
  const card = document.createElement("article");
  card.className = "request";
  const heading = document.createElement("h2");
  heading.textContent = title;
  const body = document.createElement("pre");
  body.textContent = textValue(text);
  card.append(heading, body);
  return card;
}

function actionButton(label, className, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.textContent = label;
  button.addEventListener("click", () => {
    void Promise.resolve(action()).catch((error) => {
      statusLabel.textContent = error.message || "Action failed";
    });
  });
  return button;
}

async function sendPrompt(delivery) {
  const prompt = promptInput.value.trim();
  if (!prompt) return;
  promptInput.value = "";
  try {
    await runAction({
      type: "prompt",
      prompt,
      actor: actorInput.value.trim() || "Guest",
      delivery,
    }, delivery === "immediate" ? "Steering…" : "Sending…");
  } catch {
    promptInput.value = prompt;
  }
}

async function runAction(action, pendingMessage) {
  statusLabel.textContent = pendingMessage;
  const response = await fetch("/api/actions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: crypto.randomUUID(), ...action }),
  });
  const payload = await response.json();
  if (!response.ok) {
    statusLabel.textContent = payload.error?.message || "Action failed";
    throw new Error(statusLabel.textContent);
  }
  statusLabel.textContent = "Done.";
  return payload;
}

function mergeStoredReplica() {
  if (!state.sessionId) return [];
  try {
    const replica = JSON.parse(localStorage.getItem(storageKey()) || "[]");
    for (const event of replica) mergeEvent(event, true);
    return replica;
  } catch {
    localStorage.removeItem(storageKey());
    return [];
  }
}

async function publishReplica(events) {
  if (events.length === 0) return;
  try {
    const response = await fetch("/api/events/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ events }),
    });
    if (response.ok) return;
  } catch {
    // The live EventSource will reconnect independently.
  }
  if (connectionLabel.textContent === "Live") {
    statusLabel.textContent = "The live session works, but this browser replica did not merge.";
  }
}

let persistTimer;
function persistReplicaSoon() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(persistReplica, 100);
}

function persistReplica() {
  if (!state.sessionId) return;
  try {
    localStorage.setItem(storageKey(), JSON.stringify([...state.events.values()]));
  } catch {
    statusLabel.textContent = "Live sync works, but this browser could not retain a local replica.";
  }
}

function storageKey() {
  return `candace-pair-events:${state.sessionId}`;
}

function setConnection(kind, label) {
  connectionDot.className = `dot ${kind}`;
  connectionLabel.textContent = label;
}

function disableControls(disabled) {
  for (const control of document.querySelectorAll("button, input, select, textarea")) {
    control.disabled = disabled;
  }
}

function compareEvents(left, right) {
  const byTime = String(left.timestamp ?? "").localeCompare(String(right.timestamp ?? ""));
  return byTime || left.id.localeCompare(right.id);
}

function isVisibleEvent(event) {
  return [
    "user.message",
    "assistant.message",
    "tool.execution_start",
    "tool.execution_complete",
    "session.error",
  ].includes(event.type);
}

function describePermission(data) {
  const request = data?.permissionRequest ?? {};
  return request.fullCommandText
    || request.command
    || request.fileName
    || request.path
    || request.url
    || request.toolName
    || request.subject
    || request.kind
    || compactValue(request);
}

function currentStreamText() {
  if (state.activeStreamId && state.streams.has(state.activeStreamId)) {
    return state.streams.get(state.activeStreamId);
  }
  return [...state.streams.values()].at(-1) || "";
}

function compactValue(value) {
  if (value === undefined || value === null || value === "") return "";
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return text.length > 8_000 ? `${text.slice(0, 8_000)}\n…` : text;
}

function textValue(value) {
  if (typeof value === "string") return value;
  return compactValue(value);
}

function shortId(value) {
  return typeof value === "string" && value.length > 12 ? `${value.slice(0, 12)}…` : value || "—";
}
