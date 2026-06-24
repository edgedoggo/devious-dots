const MODULE_ID = "devious-dots";
const SOCKET = `module.${MODULE_ID}`;

const ROLL_MODES = {
  any: "Next Matching Roll",
  attack: "Next Attack Roll",
  abilityCheck: "Next Ability Check",
  abilitySave: "Next Ability Save"
};

const MODE_ORDER = ["attack", "abilityCheck", "abilitySave", "any"];

const state = {
  pending: new Map(),
  roster: new Map(),
  app: null,
  patched: false
};

Hooks.once("init", () => {
  patchRolls();
});

Hooks.once("ready", () => {
  game.socket.on(SOCKET, handleSocketMessage);

  game.deviousDots = {
    open: () => openControlPanel(),
    arm: ({ actorId, faces = 20, result = 20, mode = "any" } = {}) => armActor(actorId, faces, result, mode),
    clear: (actorId, mode = "any") => clearActor(actorId, mode)
  };
});

Hooks.on("getSceneControlButtons", (controls) => {
  if (!game.user?.isGM) return;

  const controlList = Array.isArray(controls) ? controls : Object.values(controls);
  const tokenControls = controlList.find((control) => control.name === "token");
  if (!tokenControls) return;

  tokenControls.tools.push({
    name: MODULE_ID,
    title: "Devious Dots",
    icon: "fas fa-dice-d20",
    button: true,
    onClick: () => openControlPanel()
  });
});

Hooks.on("preCreateChatMessage", (message, data) => {
  applyQueuedChatMessage(message, data);
});

function patchRolls() {
  if (state.patched) return;

  const RollClass = globalThis.foundry?.dice?.Roll ?? globalThis.Roll;
  if (!RollClass?.prototype) {
    console.warn(`${MODULE_ID} | Could not find Roll; no dice patch was installed.`);
    return;
  }

  if (RollClass.prototype.evaluate) {
    const originalEvaluate = RollClass.prototype.evaluate;
    RollClass.prototype.evaluate = function deviousDotsEvaluate(...args) {
      const evaluated = originalEvaluate.apply(this, args);
      if (evaluated instanceof Promise) {
        return evaluated.then((roll) => {
          applyQueuedRoll(roll ?? this);
          return roll;
        });
      }

      applyQueuedRoll(evaluated ?? this);
      return evaluated;
    };
  }

  if (RollClass.prototype.toMessage) {
    const originalToMessage = RollClass.prototype.toMessage;
    RollClass.prototype.toMessage = function deviousDotsToMessage(messageData = {}, options = {}) {
      applyQueuedRoll(this, messageData);
      return originalToMessage.call(this, messageData, options);
    };
  }

  state.patched = true;
}

function applyQueuedRoll(roll, messageData = {}, actorId = null) {
  const resolvedActorId = actorId ?? getRollActorId(roll, messageData);
  const assignments = getAssignmentsForActor(resolvedActorId);
  if (!roll || !assignments?.size) return false;

  const target = findQueuedTarget(roll, messageData, assignments);
  if (!target) return false;

  const { assignment, mode, term, result } = target;
  const original = Number(result.result);
  const forced = assignment.result;

  result.result = forced;
  result.active = result.active !== false;

  adjustRollTotal(roll, forced - original);
  consumeAssignment(mode, assignment, resolvedActorId);

  notifyGMs({
    type: "spent",
    actorId: resolvedActorId,
    actorName: game.actors.get(resolvedActorId)?.name ?? assignment.actorName,
    mode,
    faces: term.faces,
    result: forced,
    original
  });

  return true;
}

function applyQueuedChatMessage(message, data = {}) {
  const actorId = getMessageActorId(message, data);
  const assignments = getAssignmentsForActor(actorId);
  if (!assignments?.size) return false;

  const rolls = getMessageRolls(message, data);
  if (!rolls.length) return false;

  for (const roll of rolls) {
    const applied = applyQueuedRoll(roll, { messageData: data, messageSource: message }, actorId);
    if (!applied) continue;

    updateMessageRolls(message, data, rolls);
    return true;
  }

  return false;
}

function getMessageActorId(message, data = {}) {
  return getActorIdFromSpeaker(message?.speaker)
    ?? getActorIdFromSpeaker(data?.speaker)
    ?? getActorIdFromFlags(message?.flags)
    ?? getActorIdFromFlags(data?.flags)
    ?? getActorIdFromObject(message)
    ?? getActorIdFromObject(data)
    ?? null;
}

function getRollActorId(roll, messageData = {}) {
  return getActorIdFromObject(roll)
    ?? getActorIdFromObject(roll?.options)
    ?? getMessageActorId(messageData?.messageSource, messageData?.messageData)
    ?? getActorIdFromObject(messageData)
    ?? null;
}

function getActorIdFromSpeaker(speaker) {
  if (!speaker) return null;
  if (typeof speaker.actor === "string") return speaker.actor;
  if (speaker.actor?.id) return speaker.actor.id;
  if (typeof speaker.actorId === "string") return speaker.actorId;
  return null;
}

function getActorIdFromFlags(flags) {
  return getActorIdFromObject(flags?.dnd5e)
    ?? getActorIdFromObject(flags?.world)
    ?? getActorIdFromObject(flags);
}

function getActorIdFromObject(value, depth = 0, seen = new Set()) {
  if (!value || typeof value !== "object" || depth > 4 || seen.has(value)) return null;
  seen.add(value);

  if (value.actor?.id) return value.actor.id;
  if (typeof value.actor === "string" && game.actors.has(value.actor)) return value.actor;

  for (const key of ["actorId", "actorID", "actorUuid", "actorUUID", "uuid"]) {
    const id = extractActorId(value[key]);
    if (id) return id;
  }

  for (const entry of Object.values(value)) {
    const id = getActorIdFromObject(entry, depth + 1, seen);
    if (id) return id;
  }

  return null;
}

function extractActorId(value) {
  if (typeof value !== "string") return null;
  if (game.actors.has(value)) return value;

  const match = value.match(/Actor\.([^./]+)/);
  if (match && game.actors.has(match[1])) return match[1];

  return null;
}

function getActorOwnerIds(actor) {
  return game.users
    .filter((user) => !user.isGM && canUserRollActor(user, actor))
    .map((user) => user.id);
}

function canCurrentUserRollActor(actorId, ownerIds = []) {
  if (game.user?.isGM) return true;
  if (ownerIds.includes(game.user?.id)) return true;

  const actor = game.actors.get(actorId);
  return actor ? canUserRollActor(game.user, actor) : false;
}

function canUserRollActor(user, actor) {
  if (!user || !actor) return false;

  if (typeof actor.testUserPermission === "function") {
    return actor.testUserPermission(user, "OWNER");
  }

  const level = actor.ownership?.[user.id] ?? actor.data?.permission?.[user.id] ?? 0;
  return Number(level) >= 3;
}

function getPlayerCharacters() {
  return game.actors
    .filter((actor) => {
      if (actor.type && actor.type !== "character") return false;
      return getActorOwnerIds(actor).length > 0;
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function getAssignmentsForActor(actorId) {
  if (!actorId) return null;
  return state.pending.get(actorId) ?? state.roster.get(actorId) ?? null;
}

function findQueuedTarget(roll, messageData, assignments = state.pending) {
  const terms = getRollTerms(roll);
  if (!terms.length) return null;

  const classification = classifyRoll(roll, messageData);
  for (const mode of MODE_ORDER) {
    const assignment = assignments.get(mode);
    if (!assignment) continue;
    if (mode !== "any" && mode !== classification) continue;

    const target = findMatchingDieResult(terms, assignment.faces);
    if (target) return { ...target, assignment, mode };
  }

  return null;
}

function getMessageRolls(message, data = {}) {
  if (Array.isArray(message?.rolls) && message.rolls.length) return message.rolls;
  if (Array.isArray(data?.rolls)) return data.rolls.map((roll) => hydrateRoll(roll)).filter(Boolean);
  if (data?.roll) {
    const roll = hydrateRoll(data.roll);
    return roll ? [roll] : [];
  }

  return [];
}

function hydrateRoll(roll) {
  if (!roll) return null;
  if (roll.terms || roll.total != null) return roll;

  const RollClass = globalThis.foundry?.dice?.Roll ?? globalThis.Roll;
  if (!RollClass) return null;

  try {
    if (typeof roll === "string") return RollClass.fromJSON(roll);
    if (typeof RollClass.fromData === "function") return RollClass.fromData(roll);
    if (typeof RollClass.fromJSON === "function") return RollClass.fromJSON(JSON.stringify(roll));
  } catch (error) {
    console.warn(`${MODULE_ID} | Could not read chat message roll.`, error);
  }

  return null;
}

function updateMessageRolls(message, data, rolls) {
  const serialized = rolls.map((roll) => serializeRoll(roll));
  const content = rewriteMessageContent(message?.content ?? data?.content, rolls);
  const source = { rolls: serialized };

  if (content) source.content = content;

  if (typeof message?.updateSource === "function") {
    message.updateSource(source);
  }

  if (data && typeof data === "object") {
    data.rolls = serialized;
    if (content) data.content = content;
  }
}

function serializeRoll(roll) {
  if (typeof roll?.toJSON === "function") return roll.toJSON();
  if (typeof roll?.toObject === "function") return roll.toObject();
  return roll;
}

function rewriteMessageContent(content, rolls) {
  if (typeof content !== "string" || !content) return null;

  let index = 0;
  return content.replace(/(<[^>]*class=["'][^"']*\bdice-total\b[^"']*["'][^>]*>)([\s\S]*?)(<\/[^>]+>)/gi, (match, open, _value, close) => {
    const roll = rolls[index++];
    if (!roll || !Number.isFinite(Number(roll.total))) return match;
    return `${open}${Number(roll.total)}${close}`;
  });
}

function getRollTerms(roll) {
  const directTerms = Array.isArray(roll.terms) ? roll.terms : [];
  return flattenTerms(directTerms);
}

function flattenTerms(terms) {
  const flattened = [];

  for (const term of terms) {
    if (!term) continue;
    flattened.push(term);

    if (Array.isArray(term.terms)) flattened.push(...flattenTerms(term.terms));
    if (Array.isArray(term.rolls)) {
      for (const roll of term.rolls) flattened.push(...getRollTerms(roll));
    }
  }

  return flattened;
}

function findMatchingDieResult(terms, faces) {
  for (const term of terms) {
    if (Number(term.faces) !== faces || !Array.isArray(term.results)) continue;

    const result = term.results.find((entry) => {
      return entry
        && typeof entry === "object"
        && entry.active !== false
        && Number.isFinite(Number(entry.result));
    });

    if (result) return { term, result };
  }

  return null;
}

function adjustRollTotal(roll, delta) {
  if (!Number.isFinite(delta) || delta === 0) return;

  if (typeof roll._evaluateTotal === "function") {
    try {
      roll._total = roll._evaluateTotal();
      return;
    } catch (error) {
      console.warn(`${MODULE_ID} | Could not recalculate roll total, applying delta instead.`, error);
    }
  }

  if (Number.isFinite(Number(roll._total))) roll._total = Number(roll._total) + delta;
  else if (Number.isFinite(Number(roll.total))) roll._total = Number(roll.total) + delta;
}

function classifyRoll(roll, messageData = {}) {
  const text = collectText({ rollOptions: roll?.options, messageData }).toLowerCase();

  if (/\bdeath\s*save\b/.test(text) || /\bdeath\s*saving\s*throw\b/.test(text)) return "abilitySave";
  if (/\bsaving\s*throw\b/.test(text) || /\bsave\b/.test(text)) return "abilitySave";
  if (/\bability\s*check\b/.test(text) || /\bskill\s*check\b/.test(text) || /\bcheck\b/.test(text)) return "abilityCheck";
  if (/\battack\s*roll\b/.test(text) || /\battack\b/.test(text)) return "attack";

  return null;
}

function collectText(value, depth = 0, seen = new Set()) {
  if (value == null || depth > 5) return "";

  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return ` ${value}`;
  }

  if (typeof value !== "object" || seen.has(value)) return "";
  seen.add(value);

  return Object.entries(value)
    .map(([key, entry]) => ` ${key} ${collectText(entry, depth + 1, seen)}`)
    .join(" ");
}

function consumeAssignment(mode, assignment, actorId) {
  const pendingAssignments = state.pending.get(actorId);
  if (pendingAssignments) {
    pendingAssignments.delete(mode);
    if (!pendingAssignments.size) state.pending.delete(actorId);
  }

  const actorAssignments = state.roster.get(actorId);
  if (actorAssignments) {
    actorAssignments.delete(mode);
    if (!actorAssignments.size) state.roster.delete(actorId);
  }

  assignment.spentAt = Date.now();
}

function escapeHTML(value) {
  const div = document.createElement("div");
  div.textContent = String(value ?? "");
  return div.innerHTML;
}

function openControlPanel() {
  if (!game.user?.isGM) {
    ui.notifications.warn("Only GMs can control Devious Dots.");
    return;
  }

  state.app ??= new DeviousDotsPanel();
  state.app.render(true);
}

async function armActor(actorId, faces, result, mode = "any") {
  if (!game.user?.isGM) return;

  const normalized = normalizeAssignment(actorId, faces, result, mode);
  if (!normalized) return;

  const payload = {
    type: "arm",
    senderId: game.user.id,
    senderName: game.user.name,
    ...normalized
  };

  applyArm(payload);
  game.socket.emit(SOCKET, payload);
}

async function clearActor(actorId, mode = "any") {
  if (!game.user?.isGM || !actorId) return;

  const payload = {
    type: "clear",
    senderId: game.user.id,
    senderName: game.user.name,
    actorId,
    mode
  };

  applyClear(payload);
  game.socket.emit(SOCKET, payload);
}

function normalizeAssignment(actorId, faces, result, mode) {
  const actor = game.actors.get(actorId);
  const normalizedFaces = Math.trunc(Number(faces));
  const normalizedResult = Math.trunc(Number(result));
  const normalizedMode = ROLL_MODES[mode] ? mode : "any";

  if (!actor) {
    ui.notifications.warn("Choose a valid character.");
    return null;
  }

  if (!Number.isInteger(normalizedFaces) || normalizedFaces < 2) {
    ui.notifications.warn("Choose a die size of d2 or larger.");
    return null;
  }

  if (!Number.isInteger(normalizedResult) || normalizedResult < 1 || normalizedResult > normalizedFaces) {
    ui.notifications.warn(`Choose a result from 1 to ${normalizedFaces}.`);
    return null;
  }

  return {
    actorId,
    actorName: actor.name,
    ownerIds: getActorOwnerIds(actor),
    faces: normalizedFaces,
    result: normalizedResult,
    mode: normalizedMode,
    createdAt: Date.now()
  };
}

function handleSocketMessage(payload) {
  if (!payload || payload.senderId === game.user.id) return;

  const sender = game.users.get(payload.senderId);

  if (payload.type === "spent" && sender) {
    applySpent(payload);
    return;
  }

  if (!sender?.isGM) return;

  if (payload.type === "arm") applyArm(payload);
  if (payload.type === "clear") applyClear(payload);
}

function applyArm(payload) {
  const assignment = {
    actorId: payload.actorId,
    actorName: payload.actorName,
    ownerIds: Array.isArray(payload.ownerIds) ? payload.ownerIds : [],
    faces: Number(payload.faces),
    result: Number(payload.result),
    mode: ROLL_MODES[payload.mode] ? payload.mode : "any",
    createdAt: payload.createdAt ?? Date.now()
  };

  const actorAssignments = state.roster.get(payload.actorId) ?? new Map();
  actorAssignments.set(assignment.mode, assignment);
  state.roster.set(payload.actorId, actorAssignments);

  if (canCurrentUserRollActor(payload.actorId, assignment.ownerIds)) {
    const pendingAssignments = state.pending.get(payload.actorId) ?? new Map();
    pendingAssignments.set(assignment.mode, assignment);
    state.pending.set(payload.actorId, pendingAssignments);
  }

  state.app?.render(false);
}

function applyClear(payload) {
  const mode = ROLL_MODES[payload.mode] ? payload.mode : "any";
  const actorAssignments = state.roster.get(payload.actorId);

  if (actorAssignments) {
    actorAssignments.delete(mode);
    if (!actorAssignments.size) state.roster.delete(payload.actorId);
  }

  const pendingAssignments = state.pending.get(payload.actorId);
  if (pendingAssignments) {
    pendingAssignments.delete(mode);
    if (!pendingAssignments.size) state.pending.delete(payload.actorId);
  }

  state.app?.render(false);
}

function applySpent(payload) {
  const mode = ROLL_MODES[payload.mode] ? payload.mode : "any";
  const actorAssignments = state.roster.get(payload.actorId);

  if (actorAssignments) {
    actorAssignments.delete(mode);
    if (!actorAssignments.size) state.roster.delete(payload.actorId);
  }

  const pendingAssignments = state.pending.get(payload.actorId);
  if (pendingAssignments) {
    pendingAssignments.delete(mode);
    if (!pendingAssignments.size) state.pending.delete(payload.actorId);
  }

  state.app?.render(false);
}

function notifyGMs(payload) {
  const message = {
    type: "spent",
    senderId: game.user.id,
    senderName: game.user.name,
    ...payload
  };

  game.socket.emit(SOCKET, message);
  applySpent(message);
}

class DeviousDotsPanel extends Application {
  static get defaultOptions() {
    return foundry.utils.mergeObject(super.defaultOptions, {
      id: "devious-dots-panel",
      title: "Devious Dots",
      template: null,
      width: 500,
      height: "auto",
      classes: ["devious-dots"]
    });
  }

  async _renderInner() {
    const actors = getPlayerCharacters();
    const options = actors
      .map((actor) => `<option value="${actor.id}">${escapeHTML(actor.name)}</option>`)
      .join("");

    const rows = actors.map((actor) => {
      const assignments = state.roster.get(actor.id) ?? new Map();
      const statuses = MODE_ORDER.map((mode) => {
        const assignment = assignments.get(mode);
        if (!assignment) return "";

        return `
          <span class="dd-status">
            ${escapeHTML(ROLL_MODES[mode])}: d${assignment.faces} = ${assignment.result}
            <button type="button" data-action="clear" data-actor-id="${actor.id}" data-mode="${mode}" title="Clear ${escapeHTML(ROLL_MODES[mode])}">
              <i class="fas fa-times"></i>
            </button>
          </span>`;
      }).join("");

      return `
        <li class="dd-row">
          <span class="dd-player">${escapeHTML(actor.name)}</span>
          <span class="dd-queued">${statuses || "No queued result"}</span>
        </li>`;
    }).join("");

    const modeButtons = Object.entries(ROLL_MODES).map(([mode, label]) => {
      return `
        <button type="button" data-action="arm" data-mode="${mode}">
          <i class="fas fa-dice-d20"></i>
          ${escapeHTML(label)}
        </button>`;
    }).join("");

    return $(`
      <form class="dd-panel">
        <div class="dd-fields">
          <label>
            <span>Character</span>
            <select name="actorId">${options}</select>
          </label>
          <label>
            <span>Die</span>
            <select name="faces">
              <option value="20" selected>d20</option>
              <option value="12">d12</option>
              <option value="10">d10</option>
              <option value="8">d8</option>
              <option value="6">d6</option>
              <option value="4">d4</option>
              <option value="100">d100</option>
            </select>
          </label>
          <label>
            <span>Result</span>
            <input type="number" name="result" min="1" max="20" value="20" step="1">
          </label>
        </div>
        <div class="dd-mode-actions">${modeButtons}</div>
        <ol class="dd-roster">${rows}</ol>
      </form>
    `);
  }

  activateListeners(html) {
    super.activateListeners(html);

    html.find("[name='faces']").on("change", (event) => {
      const faces = Number(event.currentTarget.value);
      const result = html.find("[name='result']");
      result.attr("max", faces);
      if (Number(result.val()) > faces) result.val(faces);
    });

    html.find("[data-action='arm']").on("click", (event) => {
      const form = event.currentTarget.closest("form");
      const data = new FormData(form);
      armActor(data.get("actorId"), data.get("faces"), data.get("result"), event.currentTarget.dataset.mode);
    });

    html.find("[data-action='clear']").on("click", (event) => {
      clearActor(event.currentTarget.dataset.actorId, event.currentTarget.dataset.mode);
    });
  }
}
