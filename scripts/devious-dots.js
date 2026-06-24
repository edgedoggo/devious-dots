const MODULE_ID = "devious-dots";
const SOCKET = `module.${MODULE_ID}`;

const state = {
  pending: null,
  roster: new Map(),
  app: null,
  patched: false
};

Hooks.once("init", () => {
  patchDieRolls();
});

Hooks.once("ready", () => {
  game.socket.on(SOCKET, handleSocketMessage);

  game.deviousDots = {
    open: () => openControlPanel(),
    arm: ({ userId, faces = 20, result = 20 } = {}) => armUser(userId, faces, result),
    clear: (userId) => clearUser(userId)
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

function patchDieRolls() {
  if (state.patched) return;

  const DieClass = globalThis.foundry?.dice?.terms?.Die
    ?? globalThis.CONFIG?.Dice?.terms?.d
    ?? globalThis.Die;

  if (!DieClass?.prototype?.roll) {
    console.warn(`${MODULE_ID} | Could not find Die.prototype.roll; no dice patch was installed.`);
    return;
  }

  const originalRoll = DieClass.prototype.roll;
  DieClass.prototype.roll = function deviousDotsRoll(options = {}) {
    const rolled = originalRoll.call(this, options);

    if (rolled instanceof Promise) {
      return rolled.then((result) => applyQueuedResult(this, result));
    }

    return applyQueuedResult(this, rolled);
  };

  state.patched = true;
}

function applyQueuedResult(term, rolled) {
  const pending = state.pending;
  const faces = Number(term?.faces ?? 0);

  if (!pending || pending.faces !== faces || !isUsableRollResult(rolled)) return rolled;
  if (pending.result < 1 || pending.result > faces) return rolled;

  const original = rolled.result;
  rolled.result = pending.result;
  rolled.active = rolled.active !== false;

  state.pending = null;
  state.roster.delete(game.user.id);

  notifyGMs({
    type: "spent",
    userId: game.user.id,
    userName: game.user.name,
    faces,
    result: pending.result,
    original
  });

  return rolled;
}

function isUsableRollResult(rolled) {
  return rolled && typeof rolled === "object" && Number.isFinite(Number(rolled.result));
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

async function armUser(userId, faces, result) {
  if (!game.user?.isGM) return;

  const normalized = normalizeAssignment(userId, faces, result);
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

async function clearUser(userId) {
  if (!game.user?.isGM || !userId) return;

  const payload = {
    type: "clear",
    senderId: game.user.id,
    senderName: game.user.name,
    userId
  };

  applyClear(payload);
  game.socket.emit(SOCKET, payload);
}

function normalizeAssignment(userId, faces, result) {
  const user = game.users.get(userId);
  const normalizedFaces = Math.trunc(Number(faces));
  const normalizedResult = Math.trunc(Number(result));

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
    createdAt: payload.createdAt ?? Date.now()
  };

  state.roster.set(payload.userId, assignment);
  if (payload.userId === game.user.id) state.pending = assignment;

  state.app?.render(false);
  if (game.user?.isGM) {
    ui.notifications.info(`${assignment.userName}'s next d${assignment.faces} will be ${assignment.result}.`);
  }
}

function applyClear(payload) {
  state.roster.delete(payload.userId);
  if (payload.userId === game.user.id) state.pending = null;

  state.app?.render(false);
  if (game.user?.isGM) {
    const userName = game.users.get(payload.userId)?.name ?? "Player";
    ui.notifications.info(`Cleared ${userName}'s queued die.`);
  }
}

function applySpent(payload) {
  state.roster.delete(payload.userId);
  state.app?.render(false);

  if (game.user?.isGM) {
    ui.notifications.info(`${payload.userName}'s d${payload.faces} became ${payload.result}.`);
  }
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
      width: 420,
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
      const assignment = state.roster.get(user.id);
      const status = assignment
        ? `Next d${assignment.faces}: ${assignment.result}`
        : "No queued result";

      return `
        <li class="dd-row">
          <span>${escapeHTML(user.name)}</span>
          <span>${status}</span>
          <button type="button" data-action="clear" data-user-id="${user.id}" title="Clear queued result">
            <i class="fas fa-times"></i>
          </button>
        </li>`;
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
        <div class="dd-actions">
          <button type="submit">
            <i class="fas fa-dice-d20"></i>
            Arm Next Matching Roll
          </button>
        </div>
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

    html.on("submit", (event) => {
      event.preventDefault();
      const form = new FormData(event.currentTarget);
      armUser(form.get("userId"), form.get("faces"), form.get("result"));
    });

    html.find("[data-action='clear']").on("click", (event) => {
      clearUser(event.currentTarget.dataset.userId);
    });
  }
}
