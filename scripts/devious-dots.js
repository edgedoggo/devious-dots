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
    arm: ({ userId, faces = 20, result = 20, mode = "any" } = {}) => armUser(userId, faces, result, mode),
    clear: (userId, mode = "any") => clearUser(userId, mode)
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

function applyQueuedRoll(roll, messageData = {}) {
  if (!roll || !state.pending.size) return false;

  const target = findQueuedTarget(roll, messageData);
  if (!target) return false;

  const { assignment, mode, term, result } = target;
  const original = Number(result.result);
  const forced = assignment.result;

  result.result = forced;
  result.active = result.active !== false;

  adjustRollTotal(roll, forced - original);
  consumeAssignment(mode, assignment);

  notifyGMs({
    type: "spent",
    userId: game.user.id,
    userName: game.user.name,
    mode,
    faces: term.faces,
    result: forced,
    original
  });

  return true;
}

function findQueuedTarget(roll, messageData) {
  const terms = getRollTerms(roll);
  if (!terms.length) return null;

  const classification = classifyRoll(roll, messageData);
  for (const mode of MODE_ORDER) {
    const assignment = state.pending.get(mode);
    if (!assignment) continue;
    if (mode !== "any" && mode !== classification) continue;

    const target = findMatchingDieResult(terms, assignment.faces);
    if (target) return { ...target, assignment, mode };
  }

  return null;
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

function consumeAssignment(mode, assignment) {
  state.pending.delete(mode);

  const userAssignments = state.roster.get(game.user.id);
  if (userAssignments) {
    userAssignments.delete(mode);
    if (!userAssignments.size) state.roster.delete(game.user.id);
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

async function armUser(userId, faces, result, mode = "any") {
  if (!game.user?.isGM) return;

  const normalized = normalizeAssignment(userId, faces, result, mode);
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

async function clearUser(userId, mode = "any") {
  if (!game.user?.isGM || !userId) return;

  const payload = {
    type: "clear",
    senderId: game.user.id,
    senderName: game.user.name,
    userId,
    mode
  };

  applyClear(payload);
  game.socket.emit(SOCKET, payload);
}

function normalizeAssignment(userId, faces, result, mode) {
  const user = game.users.get(userId);
  const normalizedFaces = Math.trunc(Number(faces));
  const normalizedResult = Math.trunc(Number(result));
  const normalizedMode = ROLL_MODES[mode] ? mode : "any";

  if (!user) {
    ui.notifications.warn("Choose a valid player.");
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
    userId,
    userName: user.name,
    faces: normalizedFaces,
    result: normalizedResult,
    mode: normalizedMode,
    createdAt: Date.now()
  };
}

function handleSocketMessage(payload) {
  if (!payload || payload.senderId === game.user.id) return;

  const sender = game.users.get(payload.senderId);

  if (payload.type === "spent" && sender && payload.senderId === payload.userId) {
    applySpent(payload);
    return;
  }

  if (!sender?.isGM) return;

  if (payload.type === "arm") applyArm(payload);
  if (payload.type === "clear") applyClear(payload);
}

function applyArm(payload) {
  const assignment = {
    userId: payload.userId,
    userName: payload.userName,
    faces: Number(payload.faces),
    result: Number(payload.result),
    mode: ROLL_MODES[payload.mode] ? payload.mode : "any",
    createdAt: payload.createdAt ?? Date.now()
  };

  const userAssignments = state.roster.get(payload.userId) ?? new Map();
  userAssignments.set(assignment.mode, assignment);
  state.roster.set(payload.userId, userAssignments);

  if (payload.userId === game.user.id) state.pending.set(assignment.mode, assignment);
  state.app?.render(false);
}

function applyClear(payload) {
  const mode = ROLL_MODES[payload.mode] ? payload.mode : "any";
  const userAssignments = state.roster.get(payload.userId);

  if (userAssignments) {
    userAssignments.delete(mode);
    if (!userAssignments.size) state.roster.delete(payload.userId);
  }

  if (payload.userId === game.user.id) state.pending.delete(mode);
  state.app?.render(false);
}

function applySpent(payload) {
  const mode = ROLL_MODES[payload.mode] ? payload.mode : "any";
  const userAssignments = state.roster.get(payload.userId);

  if (userAssignments) {
    userAssignments.delete(mode);
    if (!userAssignments.size) state.roster.delete(payload.userId);
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
    const players = game.users.filter((user) => !user.isGM && user.active);
    const users = players.length ? players : game.users.filter((user) => !user.isGM);
    const options = users
      .map((user) => `<option value="${user.id}">${escapeHTML(user.name)}</option>`)
      .join("");

    const rows = users.map((user) => {
      const assignments = state.roster.get(user.id) ?? new Map();
      const statuses = MODE_ORDER.map((mode) => {
        const assignment = assignments.get(mode);
        if (!assignment) return "";

        return `
          <span class="dd-status">
            ${escapeHTML(ROLL_MODES[mode])}: d${assignment.faces} = ${assignment.result}
            <button type="button" data-action="clear" data-user-id="${user.id}" data-mode="${mode}" title="Clear ${escapeHTML(ROLL_MODES[mode])}">
              <i class="fas fa-times"></i>
            </button>
          </span>`;
      }).join("");

      return `
        <li class="dd-row">
          <span class="dd-player">${escapeHTML(user.name)}</span>
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
            <span>Player</span>
            <select name="userId">${options}</select>
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
      armUser(data.get("userId"), data.get("faces"), data.get("result"), event.currentTarget.dataset.mode);
    });

    html.find("[data-action='clear']").on("click", (event) => {
      clearUser(event.currentTarget.dataset.userId, event.currentTarget.dataset.mode);
    });
  }
}
