
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys";

import pino from "pino";
import http from "node:http";
import fs from "node:fs/promises";
import crypto from "node:crypto";

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
let connectionPromise = null;
let reconnectTimer = null;
let stopping = false;

const pending = [];
const queuedIds = new Set();
let processingQueue = false;

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

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

  const part = type =>
    parts.find(p => p.type === type)?.value || "";

  return `${part("year")}-${part("month")}-${part("day")}`;
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

// Hantar poster sahaja, tanpa kapsyen.
async function sendBirthday(data) {
  if (!sock || !isConnected) {
    throw new Error("WhatsApp belum bersambung.");
  }

  if (!GROUP_JID.endsWith("@g.us")) {
    throw new Error(
      "WHATSAPP_GROUP_JID belum ditetapkan dengan ID kumpulan yang betul."
    );
  }

  const nama = String(data.nama || "").trim();
  const tarikh = normalizeDate(data.tarikh);
  const poster = String(data.poster || "").trim();

  if (!nama || !tarikh) {
    throw new Error("Nama atau tarikh lahir tiada.");
  }

  if (!poster) {
    throw new Error("URL poster tidak tersedia.");
  }

  const key = birthdayKey(nama, tarikh);
  const log = await readLog();

  if (log[key]?.status === "sent") {
    return {
      status: "duplicate_skipped",
      message: "Poster untuk staf ini sudah dihantar hari ini."
    };
  }

  log[key] = {
    nama,
    tarikh,
    status: "pending",
    createdAt: new Date().toISOString()
  };

  await writeLog(log);

  try {
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

    console.log("Poster dihantar:", nama);

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

async function processQueue() {
  if (processingQueue) return;
  processingQueue = true;

  try {
    while (pending.length > 0) {
      const item = pending.shift();
      queuedIds.delete(item.id);

      try {
        item.resolve(await sendBirthday(item.data));
      } catch (error) {
        item.reject(error);
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
    processQueue();
  });
}


function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    let size = 0;
    const maxSize = 1024 * 1024;

    req.on("data", chunk => {
      size += chunk.length;

      if (size > maxSize) {
        reject(new Error("Permintaan terlalu besar."));
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

const server = http.createServer(async (req, res) => {
  const url = new URL(
    req.url || "/",
    `http://${req.headers.host || "localhost"}`
  );

  // Semak status API dan sambungan WhatsApp.
  if (req.method === "GET" && url.pathname === "/health") {
    return jsonResponse(res, 200, {
      status: "ok",
      whatsappConnected: isConnected
    });
  }

  // Senarai kumpulan yang boleh dilihat oleh akaun WhatsApp bot.
  if (req.method === "GET" && url.pathname === "/groups") {
    if (!isConnected || !sock) {
      return jsonResponse(res, 503, {
        status: "error",
        message: "WhatsApp belum bersambung."
      });
    }

    try {
      const groups = await sock.groupFetchAllParticipating();

      const result = Object.values(groups).map(group => ({
        id: group.id,
        name: group.subject
      }));

      return jsonResponse(res, 200, {
        status: "ok",
        groups: result
      });
    } catch (error) {
      return jsonResponse(res, 500, {
        status: "error",
        message: error.message
      });
    }
  }

  // Endpoint untuk menerima permintaan poster hari lahir.
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
      suppliedKey.length !== API_SECRET.length ||
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
      console.error("Gagal menghantar poster:", error.message);

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


async function startBot() {
  if (stopping || connectionPromise) return connectionPromise;

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

      sock.ev.on("creds.update", saveCreds);

      sock.ev.on("connection.update", async update => {
        const { connection, lastDisconnect } = update;

        if (connection === "connecting") {
          console.log("Sedang menyambung ke WhatsApp...");
        }

        if (connection === "open") {
          isConnected = true;
          console.log("WhatsApp berjaya disambungkan.");

          if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
          }
        }

        if (connection === "close") {
          isConnected = false;

          const statusCode =
            lastDisconnect?.error?.output?.statusCode;

          console.log(
            "Sambungan WhatsApp ditutup. Kod:",
            statusCode
          );

          if (statusCode === DisconnectReason.loggedOut) {
            console.error(
              "Sesi WhatsApp telah log keluar. " +
              "Pair semula akaun WhatsApp sebelum cuba lagi."
            );
            return;
          }

          if (!stopping && !reconnectTimer) {
            reconnectTimer = setTimeout(() => {
              reconnectTimer = null;
              connectionPromise = null;
              startBot();
            }, 5000);
          }
        }
      });

      // Pairing code hanya diperlukan jika belum ada sesi.
      if (!state.creds.registered && PHONE_NUMBER) {
        await delay(3000);

        try {
          const code = await sock.requestPairingCode(
            PHONE_NUMBER
          );

          console.log("----------------------------------");
          console.log("WHATSAPP PAIRING CODE:", code);
          console.log(
            "WhatsApp > Peranti dipautkan > " +
            "Pautkan peranti > Pautkan dengan nombor telefon"
          );
          console.log("----------------------------------");
        } catch (error) {
          console.error(
            "Gagal mendapatkan pairing code:",
            error.message
          );
          console.error(
            "Semak nombor telefon, status sambungan dan log Render."
          );
        }
      }
    } catch (error) {
      console.error(
        "Ralat memulakan WhatsApp:",
        error.message
      );

      connectionPromise = null;

      if (!stopping && !reconnectTimer) {
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          startBot();
        }, 10000);
      }
    }
  })();

  return connectionPromise;
}

async function shutdown() {
  if (stopping) return;

  stopping = true;
  isConnected = false;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  try {
    if (sock) {
      sock.end(undefined);
    }
  } catch (error) {
    console.error("Ralat menutup WhatsApp:", error.message);
  }

  server.close(() => {
    console.log("Birthday API ditutup.");
    process.exit(0);
  });

  setTimeout(() => process.exit(0), 5000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

startBot();
