
import express from "express";
import pino from "pino";
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from "@whiskeysockets/baileys";
import fs from "node:fs/promises";
import path from "node:path";

const app = express();

app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const AUTH_DIR =
  process.env.AUTH_DIR || "./auth_info_baileys";

const API_SECRET =
  process.env.BIRTHDAY_API_SECRET || "";

const GROUP_JID =
  process.env.WHATSAPP_GROUP_JID || "";

const PHONE_NUMBER =
  (process.env.WHATSAPP_PHONE_NUMBER || "")
    .replace(/\D/g, "");

const MAX_IMAGE_SIZE = 8 * 1024 * 1024;

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
      "BIRTHDAY_API_SECRET belum ditetapkan di Render."
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

  return (
    supplied.length > 0 &&
    supplied === API_SECRET
  );
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
  const type = contentType
    .split(";")[0]
    .trim()
    .toLowerCase();

  if (type === "image/png") return ".png";
  if (type === "image/webp") return ".webp";
  if (type === "image/jpeg" || type === "image/jpg") {
    return ".jpg";
  }

  return ".jpg";
}

function getImageMimeType(contentType = "") {
  return contentType
    .split(";")[0]
    .trim()
    .toLowerCase();
}

// --------------------------------------------------
// SAMBUNGAN WHATSAPP
// --------------------------------------------------

async function startBot() {
  if (stopping) return;

  if (connectionPromise) {
    return connectionPromise;
  }

  connectionPromise = (async () => {
    await fs.mkdir(
      path.dirname(path.resolve(AUTH_DIR)),
      { recursive: true }
    );

    const { state, saveCreds } =
      await useMultiFileAuthState(AUTH_DIR);

    const socket = makeWASocket({
      auth: state,
      logger: pino({ level: "silent" }),
      markOnlineOnConnect: false,
      printQRInTerminal: false,
      connectTimeoutMs: 60000
    });

    sock = socket;
    socket.ev.on("creds.update", saveCreds);

    socket.ev.on("connection.update", async update => {
      const { connection, lastDisconnect } = update;

      if (connection === "connecting") {
        console.log(
          "Sedang menyambung ke WhatsApp..."
        );
      }

      if (connection === "open") {
        isConnected = true;
        console.log(
          "WhatsApp berjaya disambungkan."
        );
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
          "Sambungan WhatsApp ditutup. Kod:",
          statusCode,
          "Sambung semula:",
          shouldReconnect
        );

        connectionPromise = null;

        if (shouldReconnect && !stopping) {
          setTimeout(() => {
            startBot().catch(error => {
              console.error(
                "Gagal menyambung semula WhatsApp:",
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

    // Pairing code untuk sesi WhatsApp baharu
    if (!state.creds.registered) {
      if (!PHONE_NUMBER) {
        console.error(
          "WHATSAPP_PHONE_NUMBER belum ditetapkan di Render."
        );
      } else {
        setTimeout(async () => {
          try {
            if (
              stopping ||
              isConnected ||
              state.creds.registered ||
              sock !== socket
            ) {
              return;
            }

            console.log(
              "Meminta WhatsApp Pairing Code."
            );

            const code =
              await socket.requestPairingCode(
                PHONE_NUMBER
              );

            console.log(
              "WHATSAPP PAIRING CODE:",
              code
            );

            console.log(
              "Buka WhatsApp > Linked Devices > Link a device > Link with phone number."
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
    groupConfigured: Boolean(
      GROUP_JID && GROUP_JID.endsWith("@g.us")
    ),
    apiSecretConfigured: Boolean(API_SECRET)
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

    const groups =
      await sock.groupFetchAllParticipating();

    const groupList = Object.values(groups)
      .map(group => ({
        name: group.subject,
        id: group.id,
        participants:
          group.participants?.length || 0
      }))
      .sort((a, b) =>
        a.name.localeCompare(b.name)
      );

    console.log(
      "Jumlah kumpulan WhatsApp:",
      groupList.length
    );

    return res.json({
      success: true,
      total: groupList.length,
      groups: groupList
    });
  } catch (error) {
    console.error(
      "Gagal mendapatkan senarai kumpulan:",
      error.message
    );

    return res.status(500).json({
      success: false,
      message:
        "Gagal mendapatkan senarai kumpulan."
    });
  }
});

// --------------------------------------------------
// HANTAR POSTER HARI LAHIR
// --------------------------------------------------

app.post(
  "/birthday",
  requireSecret,
  async (req, res) => {
    try {
      if (!isConnected || !sock) {
        return res.status(503).json({
          success: false,
          whatsappConnected: false,
          message: "WhatsApp belum bersambung."
        });
      }

      if (
        !GROUP_JID ||
        !GROUP_JID.endsWith("@g.us")
      ) {
        return res.status(500).json({
          success: false,
          message:
            "WHATSAPP_GROUP_JID tidak sah."
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
      let contentType =
        mimeType || "image/jpeg";

      // Pilihan 1: imej dalam Base64
      if (posterBase64) {
        const cleanBase64 = posterBase64.replace(
          /^data:image\/[^;]+;base64,/i,
          ""
        );

        imageBuffer = Buffer.from(
          cleanBase64,
          "base64"
        );

        if (
          imageBuffer.length === 0 ||
          imageBuffer.length > MAX_IMAGE_SIZE
        ) {
          return res.status(400).json({
            success: false,
            message:
              "Saiz poster kosong atau melebihi 8 MB."
          });
        }

        const allowedTypes = [
          "image/jpeg",
          "image/jpg",
          "image/png",
          "image/webp"
        ];

        contentType =
          getImageMimeType(contentType);

        if (!allowedTypes.includes(contentType)) {
          return res.status(400).json({
            success: false,
            message:
              "Jenis imej tidak disokong."
          });
        }
      } else {
        // Pilihan 2: muat turun imej daripada URL
        let parsedUrl;

        try {
          parsedUrl = new URL(posterUrl);
        } catch {
          return res.status(400).json({
            success: false,
            message: "URL poster tidak sah."
          });
        }

        if (
          !["https:", "http:"].includes(
            parsedUrl.protocol
          )
        ) {
          return res.status(400).json({
            success: false,
            message:
              "URL poster mesti menggunakan HTTP atau HTTPS."
          });
        }

        const response = await fetch(posterUrl, {
          redirect: "error",
          signal: AbortSignal.timeout(20000)
        });

        if (!response.ok) {
          return res.status(400).json({
            success: false,
            message:
              `Gagal memuat turun poster. HTTP ${response.status}.`
          });
        }

        contentType = getImageMimeType(
          response.headers.get("content-type") || ""
        );

        const allowedTypes = [
          "image/jpeg",
          "image/jpg",
          "image/png",
          "image/webp"
        ];

        if (!allowedTypes.includes(contentType)) {
          return res.status(400).json({
            success: false,
            message:
              "URL tidak memulangkan jenis imej yang disokong."
          });
        }

        const declaredLength = Number(
          response.headers.get("content-length") || 0
        );

        if (
          declaredLength > MAX_IMAGE_SIZE
        ) {
          return res.status(400).json({
            success: false,
            message:
              "Saiz poster melebihi 8 MB."
          });
        }

        const arrayBuffer =
          await response.arrayBuffer();

        imageBuffer = Buffer.from(arrayBuffer);

        if (
          imageBuffer.length === 0 ||
          imageBuffer.length > MAX_IMAGE_SIZE
        ) {
          return res.status(400).json({
            success: false,
            message:
              "Saiz poster kosong atau melebihi 8 MB."
          });
        }
      }

      // Hantar poster sahaja, tanpa caption
      await sock.sendMessage(GROUP_JID, {
        image: imageBuffer,
        mimetype: contentType,
        fileName:
          `Birthday_SAPSP${getFileExtension(contentType)}`
      });

      console.log(
        "Poster hari lahir berjaya dihantar."
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
        message: "Gagal menghantar poster."
      });
    }
  }
);

// --------------------------------------------------
// MULAKAN SERVER
// --------------------------------------------------

const server = app.listen(PORT, "0.0.0.0", () => {
  console.log(
    "Birthday API berjalan pada port",
    PORT
  );

  if (!API_SECRET) {
    console.error(
      "AMARAN: BIRTHDAY_API_SECRET belum ditetapkan."
    );
  }

  startBot().catch(error => {
    console.error(
      "Gagal memulakan WhatsApp:",
      error.message
    );
  });
});

// Penutupan yang teratur
async function shutdown() {
  if (stopping) return;

  stopping = true;
  isConnected = false;

  console.log("Menutup Birthday API...");

  server.close();

  if (sock) {
    try {
      sock.end(
        new Error("Server sedang ditutup.")
      );
    } catch {
      // Socket mungkin telah ditutup.
    }
  }

  sock = null;
  connectionPromise = null;
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
