
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys";

import pino from "pino";
import http from "node:http";
import fs from "node:fs/promises";
import crypto from "node:crypto";

// ========================================
// KONFIGURASI
// ========================================

const PORT = Number(process.env.PORT || 3000);
const API_SECRET = process.env.BIRTHDAY_API_SECRET || "";
const GROUP_JID = process.env.WHATSAPP_GROUP_JID || "";
const PHONE_NUMBER = String(
  process.env.WHATSAPP_PHONE_NUMBER || ""
).replace(/\D/g, "");

const AUTH_DIR = process.env.AUTH_DIR || "auth_info_baileys";
const LOG_FILE = "birthday-log.json";

let sock = null;
let isConnected = false;
let stopping = false;
let reconnectTimer = null;
let connectionPromise = null;

const pending = [];
const queuedIds = new Set();
let processingQueue = false;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// ========================================
// UTILITI
// ========================================

function jsonResponse(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });

  res.end(JSON.stringify(data));
}

function normalizeDate(value) {
  const s = String(value || "").trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [year, month, day] = s.split("-");
    return `${day}/${month}/${year}`;
  }

  return s;
}

function todayMalaysia() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());

  const get = type =>
    parts.find(p => p.type === type)?.value || "";

  return `${get("year")}-${get("month")}-${get("day")}`;
}

function birthdayKey(nama, tarikh) {
  return crypto.createHash("sha256")
    .update([
      String(nama || "").trim().toLowerCase(),
      normalizeDate(tarikh),
      todayMalaysia()
    ].join("|"))
    .digest("hex");
}

async function readLog() {
  try {
    return JSON.parse(await fs.readFile(LOG_FILE, "utf8"));
  } catch {
    return {};
  }
}

async function writeLog(log) {
  await fs.writeFile(
    LOG_FILE,
    JSON.stringify(log, null, 2),
    "utf8"
  );
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    const maxSize = 1024 * 1024;

    req.on("data", chunk => {
      size += chunk.length;

      if (size > maxSize) {
        reject(new Error("Permintaan melebihi had 1 MB."));
        req.destroy();
        return;
      }

      body += chunk;
    });

    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Format JSON tidak sah."));
      }
    });

    req.on("error", reject);
  });
}

// ========================================
// PENGHANTARAN POSTER HARI LAHIR
// ========================================

async function sendBirthday(data) {
  if (!sock || !isConnected) {
    throw new Error("WhatsApp belum bersambung.");
  }

  if (!GROUP_JID.endsWith("@g.us")) {
    throw new Error(
      "WHATSAPP_GROUP_JID tidak sah. " +
      "Gunakan ID kumpulan yang berakhir dengan @g.us."
    );
  }

  const nama = String(data.nama || "").trim();
  const tarikh = normalizeDate(data.tarikh);
  const poster = String(data.poster || "").trim();

  if (!nama || !tarikh || !poster) {
    throw new Error("Medan nama, tarikh dan poster diperlukan.");
  }

  const key = birthdayKey(nama, tarikh);
  const log = await readLog();

  // Elakkan menghantar poster yang sama berulang kali hari ini.
  if (log[key]?.status === "sent") {
    console.log("Penghantaran pendua diabaikan:", nama);

    return { status: "duplicate_skipped" };
  }

  log[key] = {
    nama,
    tarikh,
    status: "pending",
    createdAt: new Date().toISOString()
  };

  await writeLog(log);

  try {
    // POSTER SAHAJA, TANPA KAPSYEN
    const result = await sock.sendMessage(GROUP_JID, {
      image: { url: poster }
    });

    const latestLog = await readLog();

    latestLog[key] = {
      nama,
      tarikh,
      status: "sent",
      messageId: result?.key?.id || "",
      createdAt: new Date().toISOString()
    };

    await writeLog(latestLog);

    console.log("Poster berjaya dihantar:", nama);

    return {
      status: "sent",
      messageId: result?.key?.id || ""
    };
  } catch (error) {
    const latestLog = await readLog();

    latestLog[key] = {
      nama,
      tarikh,
      status: "failed",
      error: error.message,
      createdAt: new Date().toISOString()
    };

    await writeLog(latestLog);
    throw error;
  }
}

// ========================================
// BARISAN PENGHANTARAN
// ========================================

async function processQueue() {
  if (processingQueue) return;

  processingQueue = true;

  try {
    while (pending.length > 0) {
      const item = pending.shift();

      try {
        item.resolve(await sendBirthday(item.data));
      } catch (error) {
        item.reject(error);
      } finally {
        queuedIds.delete(item.id);
      }

      await delay(1500);
    }
  } finally {
    processingQueue = false;
  }
}

function enqueueBirthday(data) {
  const id = birthdayKey(data.nama, data.tarikh);

  if (queuedIds.has(id)) {
    return Promise.resolve({ status: "already_queued" });
  }

  queuedIds.add(id);

  return new Promise((resolve, reject) => {
    pending.push({ id, data, resolve, reject });
    void processQueue();
  });
}

// ========================================
// API HTTP
// ========================================

const server = http.createServer(async (req, res) => {
  const url = new URL(
    req.url || "/",
    `http://${req.headers.host || "localhost"}`
  );

  // Status API
  if (req.method === "GET" && url.pathname === "/health") {
    return jsonResponse(res, 200, {
      status: "ok",
      whatsappConnected: isConnected
    });
  }

  // Senarai kumpulan WhatsApp
  if (req.method === "GET" && url.pathname === "/groups") {
    if (!isConnected || !sock) {
      return jsonResponse(res, 503, {
        status: "error",
        message: "WhatsApp belum bersambung."
      });
    }

    try {
      const groups = await sock.groupFetchAllParticipating();

      return jsonResponse(res, 200, {
        status: "ok",
        groups: Object.values(groups).map(group => ({
          id: group.id,
          name: group.subject
        }))
      });
    } catch (error) {
      return jsonResponse(res, 500, {
        status: "error",
        message: error.message
      });
    }
  }

  // Endpoint Birthday
  if (req.method === "POST" && url.pathname === "/birthday") {
    if (!API_SECRET) {
      return jsonResponse(res, 500, {
        status: "error",
        message: "BIRTHDAY_API_SECRET belum ditetapkan."
      });
    }

    const suppliedKey = req.headers["x-api-key"];

    if (
      typeof suppliedKey !== "string" ||
      Buffer.byteLength(suppliedKey) !==
        Buffer.byteLength(API_SECRET) ||
      !crypto.timingSafeEqual(
        Buffer.from(suppliedKey),
        Buffer.from(API_SECRET)
      )
    ) {
      return jsonResponse(res, 401, {
        status: "error",
        message: "API key tidak sah."
      });
    }

    let data;

    try {
      data = await readRequestBody(req);
    } catch (error) {
      return jsonResponse(res, 400, {
        status: "error",
        message: error.message
      });
    }

    if (!data.nama || !data.tarikh || !data.poster) {
      return jsonResponse(res, 400, {
        status: "error",
        message: "Medan nama, tarikh dan poster diperlukan."
      });
    }

    try {
      const result = await enqueueBirthday(data);
      return jsonResponse(res, 200, result);
    } catch (error) {
      console.error("Penghantaran gagal:", error.message);

      return jsonResponse(res, 500, {
        status: "error",
        message: error.message
      });
    }
  }

  return jsonResponse(res, 404, {
    status: "error",
    message: "Endpoint tidak ditemui."
  });
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Birthday API berjalan pada port ${PORT}`);
});

// ========================================
// SAMBUNGAN WHATSAPP BAILEYS
// ========================================

async function startBot() {
  if (stopping || connectionPromise) return;

  connectionPromise = (async () => {
    try {
      const { state, saveCreds } =
        await useMultiFileAuthState(AUTH_DIR);

      sock = makeWASocket({
        auth: state,
        logger: pino({ level: "silent" }),
        printQRInTerminal: false,
        browser: ["SAPSP Birthday Bot", "Chrome", "1.0.0"],
        markOnlineOnConnect: false,
        syncFullHistory: false
      });

      let pairingRequested = false;

      sock.ev.on("creds.update", saveCreds);

      sock.ev.on("connection.update", async update => {
        const { connection, lastDisconnect, qr } = update;

        // Minta pairing code hanya sekali bagi socket ini.
        if (
          !state.creds.registered &&
          PHONE_NUMBER &&
          !pairingRequested &&
          (connection === "connecting" || Boolean(qr))
        ) {
          pairingRequested = true;

          try {
            // Beri masa untuk sambungan WebSocket dimulakan.
            await delay(1500);

            if (!state.creds.registered && !stopping) {
              const code = await sock.requestPairingCode(
                PHONE_NUMBER
              );

              console.log("================================");
              console.log("WHATSAPP PAIRING CODE:", code);
              console.log(
                "WhatsApp > Peranti dipautkan > " +
                "Pautkan peranti > Pautkan dengan nombor telefon"
              );
              console.log("================================");
            }
          } catch (error) {
            console.error(
              "Gagal mendapatkan pairing code:",
              error.message
            );
          }
        }

        if (connection === "connecting") {
          console.log("Sedang menyambung ke WhatsApp...");
        }

        if (connection === "open") {
          isConnected = true;
          console.log("WhatsApp berjaya disambungkan.");
        }

        if (connection === "close") {
          isConnected = false;

          const statusCode =
            lastDisconnect?.error?.output?.statusCode;

          console.error(
            "Sambungan WhatsApp ditutup. Kod:",
            statusCode
          );

          if (statusCode === DisconnectReason.loggedOut) {
            console.error(
              "Sesi telah log keluar. Pair semula diperlukan."
            );
            connectionPromise = null;
            return;
          }

          if (!stopping && !reconnectTimer) {
            reconnectTimer = setTimeout(() => {
              reconnectTimer = null;
              connectionPromise = null;
              void startBot();
            }, 5000);
          }
        }
      });
    } catch (error) {
      console.error("Ralat memulakan Baileys:", error.message);
      connectionPromise = null;

      if (!stopping && !reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          void startBot();
        }, 10000);
      }
    }
  })();

  await connectionPromise;
}

// ========================================
// PENUTUPAN SERVIS
// ========================================

async function shutdown() {
  if (stopping) return;

  stopping = true;
  isConnected = false;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    if (sock) sock.end(undefined);
  } catch (error) {
    console.error("Ralat menutup WhatsApp:", error.message);
  }

  server.close(() => {
    console.log("Birthday API ditutup.");
    process.exit(0);
  });

  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", () => void shutdown());
process.on("SIGINT", () => void shutdown());

void startBot();
