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

// Gantikan dengan ID kumpulan WhatsApp SAPSP sebenar.
const GROUP_JID = process.env.WHATSAPP_GROUP_JID || "";

const AUTH_DIR = "auth_info_baileys";
const LOG_FILE = "birthday-log.json";

let sock = null;
let isConnected = false;
let connectionPromise = null;

const pending = [];
const queuedIds = new Set();
let processingQueue = false;

// --------------------------------------------------
// UTILITI
// --------------------------------------------------

function jsonResponse(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8"
  });
  res.end(JSON.stringify(data));
}

function normalizeDate(value) {
  // Terima YYYY-MM-DD atau teks tarikh daripada AppSheet.
  const s = String(value || "").trim();

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [year, month, day] = s.split("-");
    return `${day}/${month}/${year}`;
  }

  return s;
}

function todayMalaysia() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Kuala_Lumpur",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function birthdayKey(nama, tarikh) {
  const input = [
    String(nama).trim().toLowerCase(),
    normalizeDate(tarikh),
    todayMalaysia()
  ].join("|");

  return crypto
    .createHash("sha256")
    .update(input)
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

// --------------------------------------------------
// HANTAR UCAPAN DAN POSTER
// --------------------------------------------------

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

  const key = birthdayKey(nama, tarikh);
  const log = await readLog();

  // Elak menghantar dua kali pada hari Malaysia yang sama.
  /*
  if (log[key] && log[key].status === "sent") {
    return {
      status: "duplicate_skipped",
      message: "Ucapan untuk staf ini sudah diproses hari ini."
    };
  }
*/
  
/*
  const caption =
    "🎉 SELAMAT HARI LAHIR! 🎉\n\n" +
    "Tarikh: " + tarikh + "\n\n" +
    "Dekan dan Seluruh Warga SAPSP mengucapkan Selamat Hari Lahir kepada " +
    nama + "!\n\n" +
    "Semoga dikurniakan kesihatan yang baik, " +
    "kebahagiaan dan rezeki yang berkat.\n\n" +
    "Ikhlas daripada Dekan dan Seluruh Warga SAPSP.";

  log[key] = {
    nama,
    tarikh,
    status: "pending",
    createdAt: new Date().toISOString()
  };
  await writeLog(log);

  try {
    let result;

    if (poster) {
      result = await sock.sendMessage(GROUP_JID, {
        image: { url: poster },
        caption
      });
    } else {
      result = await sock.sendMessage(GROUP_JID, {
        text: caption
      });
    }

    const latestLog = await readLog();
    latestLog[key] = {
      nama,
      tarikh,
      status: "sent",
      messageId: result?.key?.id || "",
      createdAt: new Date().toISOString()
    };
    await writeLog(latestLog);

    console.log("Mesej diproses:", nama, result?.key?.id);

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

*/

// --------------------------------------------------
// BARISAN PERMINTAAN
// --------------------------------------------------

async function processQueue() {
  if (processingQueue) return;
  processingQueue = true;

  try {
    while (pending.length > 0) {
      const item = pending.shift();
      queuedIds.delete(item.id);

      try {
        const result = await sendBirthday(item.data);
        item.resolve(result);
      } catch (error) {
        item.reject(error);
      }

      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  } finally {
    processingQueue = false;
  }
}

function enqueueBirthday(data) {
  const id = birthdayKey(data.nama, data.tarikh);

  if (queuedIds.has(id)) {
    return Promise.resolve({
      status: "already_queued"
    });
  }

  queuedIds.add(id);

  return new Promise((resolve, reject) => {
    pending.push({ id, data, resolve, reject });
    processQueue();
  });
}

// --------------------------------------------------
// HTTP API UNTUK APPSHEET
// --------------------------------------------------

const server = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return jsonResponse(res, 200, {
      status: "ok",
      whatsappConnected: isConnected
    });
  }

  if (req.method === "GET" && req.url === "/groups") {
    if (!sock || !isConnected) {
      return jsonResponse(res, 503, {
        error: "WhatsApp belum bersambung."
      });
    }

    try {
      const groups = await sock.groupFetchAllParticipating();

      const result = Object.values(groups).map(group => ({
        name: group.subject,
        id: group.id
      }));

      return jsonResponse(res, 200, result);
    } catch (error) {
      return jsonResponse(res, 500, {
        error: error.message
      });
    }
  }

  if (req.method !== "POST" || req.url !== "/birthday") {
    return jsonResponse(res, 404, {
      error: "Endpoint tidak ditemui."
    });
  }

  if (!API_SECRET) {
    return jsonResponse(res, 500, {
      error: "BIRTHDAY_API_SECRET belum ditetapkan."
    });
  }

  if (req.headers["x-api-key"] !== API_SECRET) {
    return jsonResponse(res, 401, {
      error: "Kunci API tidak sah."
    });
  }

  let body = "";

  req.on("data", chunk => {
    body += chunk;

    if (body.length > 1_000_000) {
      req.destroy();
    }
  });

  req.on("end", async () => {
    try {
      const data = JSON.parse(body);

      if (!isConnected) {
        return jsonResponse(res, 503, {
          error: "WhatsApp belum bersambung. Cuba semula kemudian."
        });
      }

      const result = await enqueueBirthday(data);

      return jsonResponse(res, 200, result);

    } catch (error) {
      console.error("Ralat endpoint:", error.message);

      return jsonResponse(res, 500, {
        status: "error",
        error: error.message
      });
    }
  });
});

// --------------------------------------------------
// SAMBUNGAN WHATSAPP (PAIRING CODE)
// --------------------------------------------------

async function startBot() {
  if (connectionPromise) return connectionPromise;

  connectionPromise = (async () => {
    const { state, saveCreds } =
      await useMultiFileAuthState(AUTH_DIR);

    const socket = makeWASocket({
      auth: state,
      logger: pino({ level: "silent" }),
      markOnlineOnConnect: false,
      printQRInTerminal: false // Tutup kod QR terminal
    });

    sock = socket;
    socket.ev.on("creds.update", saveCreds);

    // Permintaan Pairing Code jika belum berdaftar/berpasangan
    if (!socket.authState.creds.registered) {
      const phoneNumber = "60125729489"; // Nombor telefon anda
      
      setTimeout(async () => {
        try {
          console.log("Sedang menjana Pairing Code untuk nombor:", phoneNumber);
          let code = await socket.requestPairingCode(phoneNumber);
          console.log(`\n\n========================================`);
          console.log(` KOD PAIRING WHATSAPP ANDA: ${code}`);
          console.log(`========================================\n\n`);
        } catch (err) {
          console.error("Gagal mendapatkan Pairing Code:", err);
        }
      }, 4000);
    }

    socket.ev.on("connection.update", async update => {
      const { connection, lastDisconnect } = update;

      if (connection === "open") {
        isConnected = true;
        console.log("WhatsApp berjaya disambungkan.");
      }

      if (connection === "close") {
        isConnected = false;
        sock = null;

        const statusCode =
          lastDisconnect?.error?.output?.statusCode;

        const shouldReconnect =
          statusCode !== DisconnectReason.loggedOut;

        console.log(
          "Sambungan ditutup. Kod:",
          statusCode,
          "Sambung semula:",
          shouldReconnect
        );

        connectionPromise = null;

        if (shouldReconnect) {
          setTimeout(() => {
            startBot().catch(console.error);
          }, 3000);
        } else {
          console.error(
            "Sesi log keluar. Sila padam folder auth_info_baileys atau set semula untuk pairing baru."
          );
        }
      }
    });
  })();

  try {
    await connectionPromise;
  } catch (error) {
    connectionPromise = null;
    throw error;
  }
}

// --------------------------------------------------
// MULAKAN SERVER DAN BOT
// --------------------------------------------------

server.listen(PORT, "0.0.0.0", () => {
  console.log("Birthday API berjalan pada port", PORT);
});

startBot().catch(console.error);
