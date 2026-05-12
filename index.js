const http = require("http");
const express = require("express");
const cors = require("cors");
const { Server } = require("socket.io");
require("dotenv").config();

const PORT = Number(process.env.PORT || 3001);
const defaultOrigins = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "https://mesaurav.in",
  "https://www.mesaurav.in",
  "https://video-call-client-6dc5.vercel.app",
];

function normalizeOrigin(origin) {
  return String(origin || "").trim().replace(/\/+$/, "");
}

const allowedOrigins = [
  ...defaultOrigins,
  ...String(process.env.CLIENT_ORIGIN || "")
    .split(",")
    .map((s) => normalizeOrigin(s))
    .filter(Boolean),
];

function isAllowedLocalOrigin(origin) {
  return /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
}

function corsOrigin(origin, callback) {
  // Allow non-browser requests (no Origin header).
  if (!origin) return callback(null, true);
  const normalizedOrigin = normalizeOrigin(origin);
  if (allowedOrigins.includes(normalizedOrigin)) return callback(null, true);
  if (isAllowedLocalOrigin(normalizedOrigin)) return callback(null, true);
  return callback(new Error("Not allowed by CORS"));
}

const app = express();
app.use(
  cors({
    origin: corsOrigin,
    credentials: true,
  })
);
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: corsOrigin,
    credentials: true,
  },
});

/**
 * In-memory room state (no DB).
 * roomCode -> { hostId: string, guestId: string | null, roomType: "video" | "voice" }
 */
const rooms = new Map();

function generateRoomCode() {
  // 6-digit numeric code (100000-999999)
  return String(Math.floor(100000 + Math.random() * 900000));
}

function getRoomOccupants(code) {
  const room = rooms.get(code);
  if (!room) return [];
  return [room.hostId, room.guestId].filter(Boolean);
}

io.on("connection", (socket) => {
  socket.on("room:create", ({ roomType } = {}, ack) => {
    let code = generateRoomCode();
    while (rooms.has(code)) code = generateRoomCode();

    const normalizedRoomType = roomType === "voice" ? "voice" : "video";

    rooms.set(code, { hostId: socket.id, guestId: null, roomType: normalizedRoomType });
    socket.join(code);

    ack?.({ ok: true, code, roomType: normalizedRoomType });
  });

  socket.on("room:join", ({ code }, ack) => {
    const normalized = String(code || "").trim();
    const room = rooms.get(normalized);
    if (!room) return ack?.({ ok: false, error: "ROOM_NOT_FOUND" });

    const occupants = getRoomOccupants(normalized);
    if (occupants.length >= 2) return ack?.({ ok: false, error: "ROOM_FULL" });

    room.guestId = socket.id;
    rooms.set(normalized, room);
    socket.join(normalized);

    // Notify both sides to start WebRTC negotiation (host initiates offer).
    socket.to(normalized).emit("peer:joined");
    socket.emit("room:joined", { code: normalized, roomType: room.roomType });
    ack?.({ ok: true, roomType: room.roomType });
  });

  socket.on("signal", ({ code, data }) => {
    const normalized = String(code || "").trim();
    if (!rooms.has(normalized)) return;
    // Relay signaling message to the other peer in the room.
    socket.to(normalized).emit("signal", { data });
  });

  socket.on("chat:message", ({ code, message }) => {
    const normalized = String(code || "").trim();
    if (!rooms.has(normalized)) return;
    const text = String(message || "").slice(0, 2000);
    io.to(normalized).emit("chat:message", {
      id: `${Date.now()}-${socket.id}`,
      from: socket.id,
      message: text,
      ts: Date.now(),
    });
  });

  socket.on("call:end", ({ code }) => {
    const normalized = String(code || "").trim();
    if (!rooms.has(normalized)) return;
    io.to(normalized).emit("call:ended");
    rooms.delete(normalized);
  });

  socket.on("disconnect", () => {
    // If a peer disconnects, end the room and notify the other peer.
    for (const [code, room] of rooms.entries()) {
      if (room.hostId === socket.id || room.guestId === socket.id) {
        socket.to(code).emit("peer:left");
        rooms.delete(code);
        break;
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`Signaling server listening on http://localhost:${PORT}`);
  console.log(`CORS origins: ${allowedOrigins.join(", ")}`);
});
