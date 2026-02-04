const { TelegramClient } = require("telegram");
const { Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const config = require("./config");
const db = require("./database");

const clientCache = new Map();
const loginState = new Map();
const keepAliveTimers = new Map();
const keepAliveStates = new Map();
const clientLastUsed = new Map();
const clientStats = new Map();

let cleanupTimerStarted = false;
let transportWarningLogged = false;

const createDeferred = () => {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const getApiId = () => {
  const apiId = Number(config.TG_API_ID);
  if (!Number.isFinite(apiId)) {
    throw new Error("TG_API_ID is not configured");
  }
  return apiId;
};

const getApiHash = () => {
  if (!config.TG_API_HASH) {
    throw new Error("TG_API_HASH is not configured");
  }
  return config.TG_API_HASH;
};

const createLimiter = (maxConcurrent) => {
  const queue = [];
  let active = 0;

  const runNext = () => {
    if (active >= maxConcurrent || queue.length === 0) return;
    const { fn, resolve, reject } = queue.shift();
    active += 1;
    Promise.resolve()
      .then(fn)
      .then(resolve, reject)
      .finally(() => {
        active -= 1;
        runNext();
      });
  };

  return (fn) =>
    new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      runNext();
    });
};

const telegramLimiter = createLimiter(
  Math.max(1, config.TELEGRAM_MAX_CONCURRENT_REQUESTS || 1),
);

const markClientUsed = (userId) => {
  clientLastUsed.set(userId, Date.now());
};

const getClientStats = (userId) => {
  if (!clientStats.has(userId)) {
    clientStats.set(userId, {
      reconnects: 0,
      consecutiveErrors: 0,
      lastConnectMs: null,
      lastDcId: null,
    });
  }
  return clientStats.get(userId);
};

const normalizeTransport = (value) =>
  (value || "").toString().trim().toLowerCase();

const resolveConnectionClass = (transport) => {
  const classNameMap = {
    abridged: "ConnectionTCPAbridged",
    full: "ConnectionTCPFull",
    obfuscated: "ConnectionTCPObfuscated",
    websocket: "ConnectionWebSocket",
    wss: "ConnectionWebSocket",
  };
  const className = classNameMap[transport];
  if (!className) return null;

  let connectionClass = null;
  try {
    const network = require("telegram/network");
    connectionClass = network?.[className] || null;
  } catch (error) {
    connectionClass = null;
  }
  if (!connectionClass) {
    try {
      const network = require("telegram/network/connection");
      connectionClass = network?.[className] || null;
    } catch (error) {
      connectionClass = null;
    }
  }
  return connectionClass;
};

const getConnectionOptions = () => {
  const options = {};
  const transport = normalizeTransport(config.TELEGRAM_TRANSPORT || "abridged");
  const connectionClass = resolveConnectionClass(transport);
  if (connectionClass) {
    options.connection = connectionClass;
  } else if (transport && !transportWarningLogged) {
    console.warn(`Telegram transport not found: ${transport}`);
    transportWarningLogged = true;
  }
  const port = Number(config.TELEGRAM_PORT);
  if (Number.isFinite(port) && port > 0) {
    options.port = port;
  }
  return options;
};

const createClientOptions = () => ({
  connectionRetries: Math.max(0, config.TELEGRAM_CONNECT_RETRIES || 0),
  requestRetries: Math.max(0, config.TELEGRAM_REQUEST_RETRIES || 0),
  retryDelay: Math.max(0, config.TELEGRAM_RETRY_DELAY_MS || 0),
  autoReconnect: true,
  ...getConnectionOptions(),
});

const connectClient = async (client, { userId, reason } = {}) => {
  const start = Date.now();
  await client.connect();
  const durationMs = Date.now() - start;
  const dcId = client?.session?.dcId || null;
  if (userId !== undefined) {
    const stats = getClientStats(userId);
    stats.lastConnectMs = durationMs;
    stats.lastDcId = dcId;
    stats.consecutiveErrors = 0;
    if (reason === "reconnect") {
      stats.reconnects += 1;
    }
  }
  const reasonInfo = reason ? ` reason=${reason}` : "";
  const dcInfo = dcId ? ` dc=${dcId}` : "";
  console.info(
    `Telegram client connected${reasonInfo}${dcInfo} in ${durationMs}ms`,
  );
};

const createClient = async (sessionString, userId) => {
  const client = new TelegramClient(
    new StringSession(sessionString || ""),
    getApiId(),
    getApiHash(),
    createClientOptions(),
  );
  await connectClient(client, { userId, reason: "initial" });
  return client;
};

const isFatalAuthError = (error) => {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("invalid auth key") ||
    message.includes("auth_key_unused") ||
    message.includes("msg_key doesn't match") ||
    message.includes("security error")
  );
};

const isDisconnectedError = (error) => {
  const message = String(error?.message || "").toLowerCase();
  return (
    message.includes("timeout") ||
    message.includes("not connected") ||
    message.includes("handshake failed")
  );
};

const resetClient = async (userId) => {
  if (!clientCache.has(userId)) return;
  await safelyDisconnect(clientCache.get(userId));
  clientCache.delete(userId);
  stopKeepAlive(userId);
  clientLastUsed.delete(userId);
  clientStats.delete(userId);
};

const startKeepAlive = (userId, client) => {
  const minInterval = config.TELEGRAM_KEEPALIVE_MIN_MS;
  const maxInterval = config.TELEGRAM_KEEPALIVE_MAX_MS;
  if (!Number.isFinite(minInterval) || minInterval <= 0) return;
  const cappedMax =
    Number.isFinite(maxInterval) && maxInterval > 0
      ? maxInterval
      : minInterval;
  const backoffFactor =
    Number.isFinite(config.TELEGRAM_KEEPALIVE_BACKOFF_FACTOR) &&
      config.TELEGRAM_KEEPALIVE_BACKOFF_FACTOR > 1
      ? config.TELEGRAM_KEEPALIVE_BACKOFF_FACTOR
      : 1.5;
  const recoveryFactor =
    Number.isFinite(config.TELEGRAM_KEEPALIVE_RECOVERY_FACTOR) &&
      config.TELEGRAM_KEEPALIVE_RECOVERY_FACTOR > 1
      ? config.TELEGRAM_KEEPALIVE_RECOVERY_FACTOR
      : 1.2;
  const failureThreshold = Math.max(
    1,
    config.TELEGRAM_KEEPALIVE_FAILURE_THRESHOLD || 1,
  );
  const successThreshold = Math.max(
    1,
    config.TELEGRAM_KEEPALIVE_SUCCESS_THRESHOLD || 1,
  );
  if (keepAliveTimers.has(userId)) {
    clearTimeout(keepAliveTimers.get(userId));
  }
  const state = keepAliveStates.get(userId) || {
    intervalMs: minInterval,
    failures: 0,
    successes: 0,
  };
  state.intervalMs = Math.min(Math.max(state.intervalMs, minInterval), cappedMax);
  keepAliveStates.set(userId, state);

  const scheduleNext = () => {
    const timer = setTimeout(async () => {
      if (!client.connected) {
        scheduleNext();
        return;
      }
      try {
        await client.invoke(new Api.updates.GetState());
        state.successes += 1;
        state.failures = 0;
        const stats = getClientStats(userId);
        stats.consecutiveErrors = 0;
        if (state.successes >= successThreshold) {
          state.intervalMs = Math.min(
            cappedMax,
            Math.floor(state.intervalMs * recoveryFactor),
          );
          state.successes = 0;
        }
      } catch (error) {
        state.failures += 1;
        state.successes = 0;

        if (isFatalAuthError(error)) {
          console.error(
            `Fatal Telegram auth error for user ${userId} in keepalive:`,
            error.message,
          );
          await logoutTelegram(userId);
          return; // Stop keepalive
        }

        state.intervalMs = Math.max(
          minInterval,
          Math.floor(state.intervalMs / backoffFactor),
        );
        const stats = getClientStats(userId);
        stats.consecutiveErrors += 1;
        if (stats.consecutiveErrors >= config.TELEGRAM_ERROR_ALERT_THRESHOLD) {
          console.warn(
            `Telegram keepalive errors for user ${userId}: ${stats.consecutiveErrors}`,
          );
        }
        if (state.failures >= failureThreshold) {
          console.warn(
            `Telegram keepalive failures for user ${userId}: ${state.failures}`,
          );
        }
        console.warn("Telegram keepalive failed:", error?.message || error);
      }
      scheduleNext();
    }, state.intervalMs);
    keepAliveTimers.set(userId, timer);
  };

  scheduleNext();
};

const stopKeepAlive = (userId) => {
  if (keepAliveTimers.has(userId)) {
    clearTimeout(keepAliveTimers.get(userId));
    keepAliveTimers.delete(userId);
  }
  keepAliveStates.delete(userId);
};

const safelyDisconnect = async (client) => {
  try {
    await client.disconnect();
  } catch (error) {
    console.error("Error disconnecting Telegram client:", error);
  }
};

const startClientCleanup = () => {
  if (cleanupTimerStarted) return;
  cleanupTimerStarted = true;
  const intervalMs = config.TELEGRAM_CLIENT_CLEANUP_MS;
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return;
  setInterval(async () => {
    const ttlMs = config.TELEGRAM_CLIENT_TTL_MS;
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
    const now = Date.now();
    for (const [userId, client] of clientCache.entries()) {
      const lastUsed = clientLastUsed.get(userId) || 0;
      if (lastUsed && now - lastUsed > ttlMs) {
        console.info(`Closing idle Telegram client for user ${userId}`);
        await safelyDisconnect(client);
        clientCache.delete(userId);
        stopKeepAlive(userId);
        clientLastUsed.delete(userId);
        clientStats.delete(userId);
      }
    }
  }, intervalMs);
};

const withTelegramClient = async (userId, actionName, actionFn) => {
  const client = await getTelegramClient(userId);
  markClientUsed(userId);
  try {
    const result = await actionFn(client);
    const stats = getClientStats(userId);
    stats.consecutiveErrors = 0;
    return result;
  } catch (error) {
    const stats = getClientStats(userId);
    stats.consecutiveErrors += 1;

    if (isFatalAuthError(error)) {
      console.error(
        `Fatal Telegram auth error for user ${userId} during ${actionName}:`,
        error.message,
      );
      await logoutTelegram(userId);
      throw error;
    }

    if (stats.consecutiveErrors >= config.TELEGRAM_ERROR_ALERT_THRESHOLD) {
      console.warn(
        `Telegram errors for user ${userId}: ${stats.consecutiveErrors}`,
      );
    }
    if (isDisconnectedError(error)) {
      console.warn(
        `Telegram ${actionName} failed, recreating client for user ${userId}`,
      );
      await resetClient(userId);
      const freshClient = await getTelegramClient(userId);
      markClientUsed(userId);
      return await actionFn(freshClient);
    }
    throw error;
  }
};

async function getTelegramClient(userId) {
  const session = await db.getSession(userId);
  if (!session?.tg_session) {
    throw new Error("Telegram session not found");
  }

  if (clientCache.has(userId)) {
    const cachedClient = clientCache.get(userId);
    if (!cachedClient.connected) {
      try {
        await connectClient(cachedClient, { userId, reason: "reconnect" });
      } catch (error) {
        console.warn("Failed to reconnect cached Telegram client:", error);
        await safelyDisconnect(cachedClient);
        clientCache.delete(userId);
        stopKeepAlive(userId);
      }
    }
    if (clientCache.has(userId) && cachedClient.connected) {
      markClientUsed(userId);
      return cachedClient;
    }
  }

  const client = await createClient(session.tg_session, userId);
  clientCache.set(userId, client);
  startKeepAlive(userId, client);
  markClientUsed(userId);
  startClientCleanup();
  return client;
}

async function startTelegramLogin(userId, phoneNumber, options = {}) {
  if (loginState.has(userId)) {
    return { started: false, message: "Login already in progress" };
  }

  const notifyPassword = options.notifyPassword;
  const notifySuccess = options.notifySuccess;
  const notifyError = options.notifyError;

  const client = await createClient("", userId);
  const code = createDeferred();
  const password = createDeferred();

  loginState.set(userId, {
    client,
    phoneNumber,
    code,
    password,
    passwordRequested: false,
  });

  setImmediate(async () => {
    try {
      await client.start({
        phoneNumber: async () => phoneNumber,
        phoneCode: async () => code.promise,
        password: async () => {
          const state = loginState.get(userId);
          if (state && !state.passwordRequested) {
            state.passwordRequested = true;
            if (typeof notifyPassword === "function") {
              await notifyPassword();
            }
          }
          return password.promise;
        },
        onError: (error) => {
          console.error("Telegram login error:", error);
        },
      });

      const session = await db.getSession(userId);
      const sessionString = client.session.save();
      await db.saveSession(userId, {
        ...session,
        tg_session: sessionString,
        tg_order_channel_id: null,
        tg_order_channel_access_hash: null,
        tg_order_channel_title: null,
        tg_order_channel_enabled: 0,
        tg_report_channel_id: null,
        tg_report_channel_access_hash: null,
        tg_report_channel_title: null,
        tg_report_channel_enabled: 0,
      });
      clientCache.set(userId, client);
      startKeepAlive(userId, client);
      markClientUsed(userId);
      startClientCleanup();
      if (typeof notifySuccess === "function") {
        await notifySuccess();
      }
    } catch (error) {
      console.error("Failed to complete Telegram login:", error);
      if (typeof notifyError === "function") {
        await notifyError(error);
      }
    } finally {
      loginState.delete(userId);
    }
  });

  return { started: true };
}

async function startTelegramQrLogin(userId, options = {}) {
  if (loginState.has(userId)) {
    return { started: false, message: "Login already in progress" };
  }

  const notifyQr = options.notifyQr;
  const notifyPassword = options.notifyPassword;
  const notifySuccess = options.notifySuccess;
  const notifyError = options.notifyError;

  const client = await createClient("", userId);
  const password = createDeferred();

  loginState.set(userId, {
    client,
    password,
    passwordRequested: false,
  });

  setImmediate(async () => {
    try {
      await client.signInUserWithQrCode(
        { apiId: getApiId(), apiHash: getApiHash() },
        {
          qrCode: async (code) => {
            if (typeof notifyQr === "function") {
              await notifyQr(code);
            }
          },
          password: async (hint) => {
            const state = loginState.get(userId);
            if (state && !state.passwordRequested) {
              state.passwordRequested = true;
              if (typeof notifyPassword === "function") {
                await notifyPassword(hint);
              }
            }
            return password.promise;
          },
          onError: async (error) => {
            if (typeof notifyError === "function") {
              await notifyError(error);
            }
            return true;
          },
        },
      );

      const session = await db.getSession(userId);
      const sessionString = client.session.save();
      await db.saveSession(userId, {
        ...session,
        tg_session: sessionString,
        tg_order_channel_id: null,
        tg_order_channel_access_hash: null,
        tg_order_channel_title: null,
        tg_order_channel_enabled: 0,
        tg_report_channel_id: null,
        tg_report_channel_access_hash: null,
        tg_report_channel_title: null,
        tg_report_channel_enabled: 0,
      });
      clientCache.set(userId, client);
      startKeepAlive(userId, client);
      markClientUsed(userId);
      startClientCleanup();
      if (typeof notifySuccess === "function") {
        await notifySuccess();
      }
    } catch (error) {
      console.error("Failed to complete Telegram QR login:", error);
      if (typeof notifyError === "function") {
        await notifyError(error);
      }
    } finally {
      loginState.delete(userId);
    }
  });

  return { started: true };
}

async function submitTelegramCode(userId, code) {
  const state = loginState.get(userId);
  if (!state) {
    return { success: false, message: "Login not started" };
  }
  state.code.resolve(code);
  return { success: true };
}

async function submitTelegramPassword(userId, password) {
  const state = loginState.get(userId);
  if (!state) {
    return { success: false, message: "Login not started" };
  }
  state.password.resolve(password);
  return { success: true };
}

function isTelegramLoginInProgress(userId) {
  return loginState.has(userId);
}

async function cancelTelegramLogin(userId) {
  const state = loginState.get(userId);
  if (!state) {
    return false;
  }
  try {
    await state.client.disconnect();
  } catch (error) {
    console.error("Error disconnecting Telegram client:", error);
  }
  loginState.delete(userId);
  return true;
}

async function listUserChannels(userId) {
  const dialogs = await telegramLimiter(() =>
    withTelegramClient(userId, "listUserChannels", (client) =>
      client.getDialogs({}),
    ),
  );

  return dialogs
    .filter((dialog) => dialog?.isChannel || dialog?.entity instanceof Api.Channel)
    .map((dialog) => {
      const entity = dialog.entity;
      return {
        id: entity.id?.toString(),
        accessHash: entity.accessHash?.toString(),
        title: entity.title || "Без названия",
        username: entity.username || null,
      };
    })
    .filter((channel) => channel.id && channel.accessHash);
}

async function sendChannelMessage(userId, channelId, accessHash, message) {
  await telegramLimiter(() =>
    withTelegramClient(userId, "sendChannelMessage", (client) => {
      const inputPeer = new Api.InputPeerChannel({
        channelId: BigInt(channelId),
        accessHash: BigInt(accessHash),
      });
      return client.sendMessage(inputPeer, { message });
    }),
  );
}

async function logoutTelegram(userId) {
  const session = await db.getSession(userId);
  if (!session) return;
  await db.saveSession(userId, {
    ...session,
    tg_session: null,
    tg_order_channel_id: null,
    tg_order_channel_access_hash: null,
    tg_order_channel_title: null,
    tg_order_channel_enabled: 0,
    tg_report_channel_id: null,
    tg_report_channel_access_hash: null,
    tg_report_channel_title: null,
    tg_report_channel_enabled: 0,
  });
  if (clientCache.has(userId)) {
    await safelyDisconnect(clientCache.get(userId));
    clientCache.delete(userId);
  }
  stopKeepAlive(userId);
  clientLastUsed.delete(userId);
  clientStats.delete(userId);
}

module.exports = {
  getTelegramClient,
  startTelegramLogin,
  startTelegramQrLogin,
  submitTelegramCode,
  submitTelegramPassword,
  isTelegramLoginInProgress,
  cancelTelegramLogin,
  listUserChannels,
  sendChannelMessage,
  logoutTelegram,
};
