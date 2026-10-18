
import express from "express";
import pino from "pino";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys";

import fs from "fs";
import path from "path";
import os from "os";

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const AUTH_DIR =
  process.env.AUTH_DIR || "./auth_info_baileys";

const API_SECRET = process.env.BIRTHDAY_API_SECRET || "";
const GROUP_JID = process.env.WHATSAPP_GROUP_JID || "";
const PHONE_NUMBER =
  (process.env.WHATSAPP_PHONE_NUMBER || "").replace(/\D/g, "");

let sock = null;
let isConnected = false;
let connectionPromise = null;
let stopping = false;

// --------------------------------------------------
// UTILITI
// --------------------------------------------------

const delay = ms =>
  new Promise(resolve => setTimeout(resolve, ms));

function isAuthorized(req) {
  if (!API_SECRET) {
    console.error(
      "BIRTHDAY_API_SECRET belum ditetapkan dalam Render."
    );
    return false;
  }

  const headerSecret = req.get("x-api-secret");
  const bodySecret = req.body?.secret;

  const supplied =
    typeof headerSecret === "string"
      ? headerSecret
      : typeof bodySecret === "string"
        ? bodySecret
        : "";

  return supplied.length > 0 && supplied === API_SECRET;
}

function requireSecret(req, res, next) {
  if (!isAuthorized(req)) {
    return res.status(401).json({
      success: false,
      message: "API secret tidak sah."
    });
  }

  next();
}


function getFileExtension(contentType = "") {
  if (contentType.includes("png")) return ".png";
  if (contentType.includes("webp")) return ".webp";
  if (contentType.includes("jpeg") ||
      contentType.includes("jpg")) return ".jpg";

  return ".jpg";
}

// --------------------------------------------------
// SAMBUNGAN WHATSAPP
// --------------------------------------------------

async function startBot() {
  if (connectionPromise) {
    return connectionPromise;
  }

  connectionPromise = (async () => {
    const { state, saveCreds } =
      await useMultiFileAuthState(AUTH_DIR);

    const socket = makeWASocket({
      auth: state,
      logger: pino({ level: "silent" }),
      markOnlineOnConnect: false,
      printQRInTerminal: false
    });

    sock = socket;

    socket.ev.on("creds.update", saveCreds);

    socket.ev.on("connection.update", async update => {
      const { connection, lastDisconnect } = update;

      if (connection === "connecting") {
        console.log("Sedang menyambung ke WhatsApp...");
      }

      if (connection === "open") {
        isConnected = true;
        console.log("WhatsApp berjaya disambungkan.");
      }

      if (connection === "close") {
        isConnected = false;

        if (sock === socket) {
          sock = null;
        }

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

        if (shouldReconnect && !stopping) {
          setTimeout(() => {
            startBot().catch(error => {
              console.error(
                "Gagal menyambung semula:",
                error.message
              );
            });
          }, 3000);
        } else if (!shouldReconnect) {
          console.error(
            "Sesi WhatsApp telah log keluar. Pairing semula diperlukan."
          );
        }
      }
    });

    // Pairing Code hanya diperlukan untuk sesi baharu
    if (!state.creds.registered) {
      if (!PHONE_NUMBER) {
        console.error(
          "WHATSAPP_PHONE_NUMBER belum ditetapkan di Render."
        );
      } else {
        setTimeout(async () => {
          try {
            if (stopping || isConnected || state.creds.registered) {
              return;
            }

            console.log(
              "Meminta Pairing Code untuk:",
              PHONE_NUMBER
            );

            const code =
              await socket.requestPairingCode(PHONE_NUMBER);

            console.log("==================================");
            console.log("WHATSAPP PAIRING CODE:", code);
            console.log("==================================");
            console.log(
              "Masukkan kod melalui WhatsApp > Linked Devices > Link a device > Link with phone number."
            );
          } catch (error) {
            console.error(
              "Gagal mendapatkan Pairing Code:",
              error.message
            );
          }
        }, 4000);
      }
    }
  })();

  try {
    await connectionPromise;
  } catch (error) {
    connectionPromise = null;
    throw error;
  }
}

// --------------------------------------------------
// STATUS API
// --------------------------------------------------

app.get("/", (req, res) => {
  res.json({
    service: "Birthday SAPSP WhatsApp API",
    status: "running"
  });
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    whatsappConnected: isConnected,
    groupConfigured: Boolean(GROUP_JID)
  });
});


 // --------------------------------------------------
 // SENARAI GROUP WHATSAPP
 // --------------------------------------------------

app.get("/groups", requireSecret, async (req, res) => {
  try {
    if (!isConnected || !sock) {
      return res.status(503).json({
        success: false,
        whatsappConnected: false,
        message: "WhatsApp belum bersambung."
      });
    }

    const groups = await sock.groupFetchAllParticipating();

    const groupList = Object.values(groups).map(group => ({
      name: group.subject,
      id: group.id,
      participants: group.participants?.length || 0
    }));

    console.log("Senarai Group WhatsApp:", groupList);

    return res.json({
      success: true,
      total: groupList.length,
      groups: groupList
    });
  } catch (error) {
    console.error("Gagal mendapatkan senarai kumpulan:", error.message);

    return res.status(500).json({
      success: false,
      message: "Gagal mendapatkan senarai kumpulan.",
      error: error.message
    });
  }
});


// --------------------------------------------------
// HANTAR POSTER SAHAJA
// --------------------------------------------------

app.post("/birthday", requireSecret, async (req, res) => {
  try {
    if (!isConnected || !sock) {
      return res.status(503).json({
        success: false,
        message: "WhatsApp belum bersambung."
      });
    }

    if (!GROUP_JID || !GROUP_JID.endsWith("@g.us")) {
      return res.status(500).json({
        success: false,
        message: "WHATSAPP_GROUP_JID tidak sah."
      });
    }

    const {
      posterUrl,
      posterBase64,
      mimeType
    } = req.body || {};

    if (!posterUrl && !posterBase64) {
      return res.status(400).json({
        success: false,
        message:
          "Sila berikan posterUrl atau posterBase64."
      });
    }

    let imageBuffer;
    let contentType = mimeType || "image/jpeg";

    if (posterBase64) {
      const cleanBase64 = posterBase64.replace(
        /^data:image\/[^;]+;base64,/,
        ""
      );

      imageBuffer = Buffer.from(cleanBase64, "base64");
    } else {
      const response = await fetch(posterUrl, {
        redirect: "follow"
      });

      if (!response.ok) {
        return res.status(400).json({
          success: false,
          message:
            `Gagal memuat turun poster. HTTP ${response.status}.`
        });
      }

      contentType =
        response.headers.get("content-type") || contentType;

      if (!contentType.startsWith("image/")) {
        return res.status(400).json({
          success: false,
          message:
            "URL poster tidak memulangkan fail imej."
        });
      }

      const arrayBuffer = await response.arrayBuffer();
      imageBuffer = Buffer.from(arrayBuffer);
    }

    if (!imageBuffer || imageBuffer.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Fail poster kosong."
      });
    }

    // Hantar imej sahaja — tiada caption
    await sock.sendMessage(GROUP_JID, {
      image: imageBuffer,
      mimetype: contentType,
      fileName: `Birthday_SAPSP${getFileExtension(contentType)}`
    });

    console.log(
      "Poster hari lahir berjaya dihantar ke kumpulan."
    );

    return res.json({
      success: true,
      message: "Poster berjaya dihantar."
    });
  } catch (error) {
    console.error(
      "Ralat menghantar poster:",
      error.message
    );

    return res.status(500).json({
      success: false,
      message: "Gagal menghantar poster.",
      error: error.message
    });
  }
});

// --------------------------------------------------
// MULAKAN SERVER
// --------------------------------------------------

app.listen(PORT, "0.0.0.0", () => {
  console.log("Birthday API berjalan pada port", PORT);
});

startBot().catch(error => {
  console.error("Gagal memulakan bot:", error);
});
