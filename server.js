require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");
const https = require("https");

const app = express();
app.use(cors());
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;

app.get('/app.js', (req, res) => {
    console.log("Explicitly serving app.js");
    res.sendFile(path.join(__dirname, 'public', 'app.js'));
});
app.get('/app_style.css', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'app_style.css'));
});

app.use(express.static(path.join(__dirname, "public")));

// In-memory cache of rides (also appended to Google Sheet)
const rides = [];
// In-memory cache of ride requests
const requests = [];

// Persistent storage paths
const DATA_DIR = path.join(__dirname, "data");
const RIDES_FILE = path.join(DATA_DIR, "rides.json");
const REQUESTS_FILE = path.join(DATA_DIR, "requests.json");

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  try {
    fs.mkdirSync(DATA_DIR);
  } catch (e) {
    console.warn("Could not create data directory:", e.message);
  }
}

// Load persisted data on startup
function loadPersistentData() {
  try {
    if (fs.existsSync(RIDES_FILE)) {
      const data = JSON.parse(fs.readFileSync(RIDES_FILE, "utf8"));
      if (Array.isArray(data)) rides.push(...data);
    }
    if (fs.existsSync(REQUESTS_FILE)) {
      const data = JSON.parse(fs.readFileSync(REQUESTS_FILE, "utf8"));
      if (Array.isArray(data)) requests.push(...data);
    }
    console.log(
      `Loaded ${rides.length} rides and ${requests.length} requests from persistent storage.`
    );
  } catch (e) {
    console.warn("Failed to load persistent data:", e.message);
  }
}

// Save data to JSON files
function savePersistentData() {
  try {
    fs.writeFileSync(RIDES_FILE, JSON.stringify(rides, null, 2));
    fs.writeFileSync(REQUESTS_FILE, JSON.stringify(requests, null, 2));
  } catch (e) {
    console.warn("Failed to save persistent data:", e.message);
  }
}

loadPersistentData();

let sheetsClient = null;
let sheets = null;
const SHEET_ID = process.env.GOOGLE_SHEET_ID || process.env.SHEET_ID;

// Ensure logs directory exists for recording invalid attempts
const LOG_DIR = path.join(__dirname, "logs");
if (!fs.existsSync(LOG_DIR)) {
  try {
    fs.mkdirSync(LOG_DIR);
  } catch (e) {
    console.warn("Could not create logs directory:", e.message);
  }
}

function initSheets() {
  const credsPath = process.env.GOOGLE_SERVICE_ACCOUNT_FILE;
  const credsJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  let key; // service account key object
  if (credsJson) {
    try {
      key = JSON.parse(credsJson);
    } catch (err) {
      console.warn("Failed to parse GOOGLE_SERVICE_ACCOUNT_JSON:", err.message);
    }
  } else if (credsPath && fs.existsSync(credsPath)) {
    key = JSON.parse(fs.readFileSync(credsPath, "utf8"));
  }

  if (!key || !SHEET_ID) {
    console.warn(
      "Google Sheets credentials or sheet ID not found. Falling back to in-memory storage only."
    );
    return;
  }

  const jwtClient = new google.auth.JWT(
    key.client_email,
    null,
    key.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );

  sheetsClient = jwtClient;
  sheets = google.sheets({ version: "v4", auth: sheetsClient });

  sheetsClient.authorize((err) => {
    if (err) {
      console.error("Error authorizing Google Sheets client:", err);
      sheets = null;
    } else {
      console.log("Google Sheets client authorized.");
    }
  });
}

// Helper: Query Nominatim for place suggestions
function nominatimSearch(query, limit = 5) {
  return new Promise((resolve) => {
    if (!query || !query.trim()) return resolve([]);
    const q = encodeURIComponent(query);
    const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=${limit}`;
    const req = https.get(
      url,
      { headers: { "User-Agent": "ASU-Carpool-Demo/1.0" } },
      (resp) => {
        let data = "";
        resp.on("data", (chunk) => (data += chunk));
        resp.on("end", () => {
          try {
            const j = JSON.parse(data);
            const mapped = (Array.isArray(j) ? j : []).map((it) => ({
              display_name: it.display_name,
              lat: parseFloat(it.lat),
              lon: parseFloat(it.lon),
              type: it.type || null,
              class: it.class || null,
            }));
            resolve(mapped);
          } catch (e) {
            resolve([]);
          }
        });
      }
    );
    req.on("error", () => resolve([]));
    req.setTimeout(4000, () => {
      req.abort();
      resolve([]);
    });
  });
}

async function appendToSheet(row) {
  if (!sheets) return;
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: "Sheet1!A1",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [row],
      },
    });
  } catch (err) {
    console.error("Failed to append to sheet:", err.message);
  }
}

app.post("/api/driver", async (req, res) => {
  console.log("POST /api/driver received:", req.body);
  const { name, email, phone, origin, destination, seats, time } = req.body;

  if (!name || !origin || !destination) {
    return res
      .status(400)
      .json({ error: "Missing required fields: name, origin, destination" });
  }

  // Validate ASU email address (required). Allow subdomains like mail.asu.edu
  const asuEmailRegex = /[A-Z0-9._%+-]+@(?:[A-Z0-9-]+\.)?asu\.edu$/i;
  if (!email || !asuEmailRegex.test(email)) {
    // Log invalid driver attempts with timestamp and remote IP
    try {
      const line = `${new Date().toISOString()}\tINVALID_DRIVER_EMAIL\t${
        req.ip || req.connection.remoteAddress
      }\t${email || ""}\n`;
      fs.appendFileSync(path.join(LOG_DIR, "invalid_emails.log"), line);
    } catch (e) {
      console.warn("Failed to write invalid email log:", e.message);
    }

    return res.status(400).json({
      error: "Driver email is required and must be an @asu.edu address",
    });
  }

  // Phone normalization & validation (optional). If provided, must be 10 digits.
  let phoneDigits = null;
  if (phone && String(phone).trim()) {
    phoneDigits = String(phone).replace(/\D/g, "");
    if (!/^\d{10}$/.test(phoneDigits)) {
      try {
        const line = `${new Date().toISOString()}\tINVALID_DRIVER_PHONE\t${
          req.ip || req.connection.remoteAddress
        }\t${phone}\n`;
        fs.appendFileSync(path.join(LOG_DIR, "invalid_emails.log"), line);
      } catch (e) {
        /* ignore logging errors */
      }
      return res
        .status(400)
        .json({ error: "Phone must be exactly 10 digits (numbers only)" });
    }
  }
  // Try to geocode origin and destination (best-effort). Uses Nominatim (OpenStreetMap).
  async function geocode(address) {
    if (!address) return null;
    const q = encodeURIComponent(address + ", Tempe, AZ");
    const url = `https://nominatim.openstreetmap.org/search?q=${q}&format=json&limit=1`;
    return new Promise((resolve) => {
      const req = https.get(
        url,
        { headers: { "User-Agent": "ASU-Carpool-Demo/1.0" } },
        (resp) => {
          let data = "";
          resp.on("data", (chunk) => (data += chunk));
          resp.on("end", () => {
            try {
              const j = JSON.parse(data);
              if (Array.isArray(j) && j.length > 0) {
                resolve({
                  lat: parseFloat(j[0].lat),
                  lon: parseFloat(j[0].lon),
                });
              } else resolve(null);
            } catch (e) {
              resolve(null);
            }
          });
        }
      );
      req.on("error", () => resolve(null));
      req.setTimeout(3000, () => {
        req.abort();
        resolve(null);
      });
    });
  }

  let originCoords = null;
  let destCoords = null;
  try {
    originCoords = await geocode(origin);
    destCoords = await geocode(destination);
  } catch (e) {
    originCoords = null;
    destCoords = null;
  }

  const ride = {
    id: Date.now().toString(),
    name,
    email: email || "",
    phone: phoneDigits || phone || "",
    origin,
    destination,
    originLat: originCoords ? originCoords.lat : undefined,
    originLng: originCoords ? originCoords.lon : undefined,
    destLat: destCoords ? destCoords.lat : undefined,
    destLng: destCoords ? destCoords.lon : undefined,
    seats: seats || "1",
    time: time || "",
    createdAt: new Date().toISOString(),
  };

  rides.unshift(ride);
  savePersistentData();

  // try to append to Google Sheet
  const row = [
    ride.createdAt,
    ride.name,
    ride.email,
    ride.phone,
    ride.origin,
    ride.destination,
    ride.seats,
    ride.time,
  ];
  appendToSheet(row);

  res.json({ ok: true, ride });
});

// Endpoint to validate a visitor's ASU email (for revealing contact info)
app.post("/api/validate-email", (req, res) => {
  const { email } = req.body || {};
  const asuEmailRegex = /[A-Z0-9._%+-]+@(?:[A-Z0-9-]+\.)?asu\.edu$/i;
  if (!email || !asuEmailRegex.test(email)) {
    // Log invalid rider attempts
    try {
      const line = `${new Date().toISOString()}\tINVALID_RIDER_EMAIL\t${
        req.ip || req.connection.remoteAddress
      }\t${email || ""}\n`;
      fs.appendFileSync(path.join(LOG_DIR, "invalid_emails.log"), line);
    } catch (e) {
      console.warn("Failed to write invalid email log:", e.message);
    }
    return res.status(400).json({
      error: "Email must be a valid ASU address (ending with @asu.edu).",
    });
  }
  return res.json({ ok: true });
});

// Rider sends a request to join a ride
app.post("/api/request", (req, res) => {
  const { rideId, name, email, phone, message } = req.body || {};
  if (!rideId || !name) {
    return res
      .status(400)
      .json({ error: "Missing required fields: rideId and name" });
  }

  const ride = rides.find((r) => r.id === rideId);
  if (!ride) return res.status(404).json({ error: "Ride not found" });

  const asuEmailRegex = /[A-Z0-9._%+-]+@(?:[A-Z0-9-]+\.)?asu\.edu$/i;
  if (!email || !asuEmailRegex.test(email)) {
    try {
      const line = `${new Date().toISOString()}\tINVALID_REQUEST_EMAIL\t${
        req.ip || req.connection.remoteAddress
      }\t${email || ""}\n`;
      fs.appendFileSync(path.join(LOG_DIR, "invalid_emails.log"), line);
    } catch (e) {
      console.warn("Failed to write invalid email log:", e.message);
    }
    return res.status(400).json({
      error: "Rider email is required and must be an @asu.edu address",
    });
  }

  // Phone normalization & validation (optional). If provided, must be 10 digits.
  let reqPhoneDigits = null;
  if (phone && String(phone).trim()) {
    reqPhoneDigits = String(phone).replace(/\D/g, "");
    if (!/^\d{10}$/.test(reqPhoneDigits)) {
      try {
        const line = `${new Date().toISOString()}\tINVALID_REQUEST_PHONE\t${
          req.ip || req.connection.remoteAddress
        }\t${phone}\n`;
        fs.appendFileSync(path.join(LOG_DIR, "invalid_emails.log"), line);
      } catch (e) {
        /* ignore logging errors */
      }
      return res
        .status(400)
        .json({ error: "Phone must be exactly 10 digits (numbers only)" });
    }
  }

  const reqObj = {
    id: Date.now().toString(),
    rideId,
    rideDriverEmail: ride.email || "",
    name,
    email,
    phone: reqPhoneDigits || phone || "",
    status: "pending",
    message: message || "",
    createdAt: new Date().toISOString(),
  };
  requests.unshift(reqObj);
  savePersistentData();

  // append to sheet (optional)
  const row = [
    reqObj.createdAt,
    "REQUEST",
    reqObj.rideId,
    reqObj.rideDriverEmail,
    reqObj.name,
    reqObj.email,
    reqObj.phone,
    reqObj.message,
  ];
  appendToSheet(row);

  // Emit real-time event for new request
  try {
    if (typeof io !== "undefined" && io && io.emit)
      io.emit("newRequest", reqObj);
  } catch (e) {
    console.warn("Failed to emit newRequest", e && e.message);
  }

  return res.json({ ok: true, request: reqObj });
});

// Accept a request (driver action) - decrements seats and marks request accepted
app.post("/api/requests/:id/accept", (req, res) => {
  const id = req.params.id;
  const requestItem = requests.find((r) => r.id === id);
  if (!requestItem) return res.status(404).json({ error: "Request not found" });
  if (requestItem.status && requestItem.status !== "pending") {
    return res.status(400).json({ error: "Request already processed" });
  }

  const ride = rides.find((r) => r.id === requestItem.rideId);
  if (!ride)
    return res.status(404).json({ error: "Associated ride not found" });

  const seatsNum = parseInt(ride.seats || "0", 10) || 0;
  if (seatsNum <= 0)
    return res.status(400).json({ error: "No seats available" });

  // Mark request accepted and decrement seats
  requestItem.status = "accepted";
  const newSeats = Math.max(0, seatsNum - 1);
  ride.seats = String(newSeats);
  if (newSeats === 0) ride.available = false;

  savePersistentData();

  // append to sheet a note about acceptance
  try {
    appendToSheet([
      new Date().toISOString(),
      "ACCEPT",
      requestItem.id,
      requestItem.rideId,
      requestItem.name,
      requestItem.email,
      requestItem.phone,
    ]);
  } catch (e) {}

  // Emit socket events
  try {
    if (typeof io !== "undefined" && io && io.emit) {
      io.emit("requestAccepted", { request: requestItem, ride });
      io.emit("rideUpdated", ride);
    }
  } catch (e) {
    console.warn("Failed to emit requestAccepted", e && e.message);
  }

  return res.json({ ok: true, request: requestItem, ride });
});

// Rider: list my requests by rider email
app.get("/api/requests/mine", (req, res) => {
  const email = req.query.email;
  const asuEmailRegex = /[A-Z0-9._%+-]+@(?:[A-Z0-9-]+\.)?asu\.edu$/i;
  if (!email || !asuEmailRegex.test(email)) {
    return res
      .status(400)
      .json({
        error: "email query param required and must be an @asu.edu address",
      });
  }
  const filtered = requests.filter(
    (r) => (r.email || "").toLowerCase() === email.toLowerCase()
  );
  res.json(filtered);
});

// Rider: cancel their pending request
app.post("/api/requests/:id/cancel", (req, res) => {
  const id = req.params.id;
  const requestItem = requests.find((r) => r.id === id);
  if (!requestItem) return res.status(404).json({ error: "Request not found" });
  if (requestItem.status && requestItem.status !== "pending") {
    return res
      .status(400)
      .json({ error: "Only pending requests can be canceled" });
  }

  // mark canceled
  requestItem.status = "canceled";

  // if request was previously accepted (shouldn't be here due to check), we would free a seat
  const ride = rides.find((r) => r.id === requestItem.rideId);
  if (ride) {
    // if ride had available flag set false because seats were 0, restore if needed
    const seatsNum = parseInt(ride.seats || "0", 10) || 0;
    // only increment if seats < original (best-effort)
    ride.seats = String(seatsNum + 1);
    ride.available = true;
  }

  savePersistentData();

  // emit cancellation and ride update
  try {
    if (typeof io !== "undefined" && io && io.emit) {
      io.emit("requestCanceled", { request: requestItem, ride });
      if (ride) io.emit("rideUpdated", ride);
    }
  } catch (e) {}

  return res.json({ ok: true, request: requestItem, ride });
});

// Driver fetches requests for their rides by driver email
app.get("/api/requests", (req, res) => {
  const driverEmail = req.query.driverEmail;
  const asuEmailRegex = /[A-Z0-9._%+-]+@(?:[A-Z0-9-]+\.)?asu\.edu$/i;
  if (!driverEmail || !asuEmailRegex.test(driverEmail)) {
    return res.status(400).json({
      error: "driverEmail query param required and must be an @asu.edu address",
    });
  }
  const filtered = requests.filter(
    (r) => (r.rideDriverEmail || "").toLowerCase() === driverEmail.toLowerCase()
  );
  res.json(filtered);
});

// Haversine distance (km)
function distanceKm(lat1, lon1, lat2, lon2) {
  const toRad = (v) => (v * Math.PI) / 180;
  const R = 6371; // Earth radius km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

app.get("/api/rides", (req, res) => {
  const { lat, lng, radiusKm } = req.query || {};
  if (lat && lng) {
    const userLat = parseFloat(lat);
    const userLng = parseFloat(lng);
    const rKm = radiusKm ? parseFloat(radiusKm) : 10; // default 10 km
    if (isNaN(userLat) || isNaN(userLng) || isNaN(rKm)) {
      return res.status(400).json({ error: "Invalid lat/lng/radiusKm" });
    }

    const filtered = rides
      .map((ride) => {
        if (
          ride.originLat !== undefined &&
          ride.originLng !== undefined &&
          !isNaN(ride.originLat) &&
          !isNaN(ride.originLng)
        ) {
          const d = distanceKm(
            userLat,
            userLng,
            ride.originLat,
            ride.originLng
          );
          return { ...ride, distanceKm: Math.round(d * 10) / 10 };
        }
        return { ...ride, distanceKm: null };
      })
      .filter((r) => (r.distanceKm === null ? false : r.distanceKm <= rKm))
      .sort((a, b) => a.distanceKm - b.distanceKm);

    return res.json(filtered);
  }

  res.json(rides);
});

// Suggest places via Nominatim: /api/places?q=Tempe+ASU
app.get("/api/places", async (req, res) => {
  try {
    const q = req.query.q || req.query.query || "";
    const limit = Math.min(1 * (req.query.limit || 5), 20);
    const results = await nominatimSearch(q, limit);
    res.json(results);
  } catch (e) {
    res.status(500).json({ error: "Failed to fetch places" });
  }
});

// Return unique origins from stored rides with counts and coords
app.get("/api/origins", (req, res) => {
  try {
    const map = new Map();
    rides.forEach((r) => {
      const key = (r.origin || "").trim();
      if (!key) return;
      const entry = map.get(key) || {
        origin: key,
        count: 0,
        lat: r.originLat,
        lng: r.originLng,
      };
      entry.count += 1;
      // prefer existing coords if missing
      if (
        (entry.lat === undefined || entry.lat === null) &&
        r.originLat !== undefined
      )
        entry.lat = r.originLat;
      if (
        (entry.lng === undefined || entry.lng === null) &&
        r.originLng !== undefined
      )
        entry.lng = r.originLng;
      map.set(key, entry);
    });
    const arr = Array.from(map.values()).sort((a, b) => b.count - a.count);
    res.json(arr);
  } catch (e) {
    res.status(500).json({ error: "Failed to compute origins" });
  }
});

// Return unique destinations from stored rides with counts and coords
app.get("/api/destinations", (req, res) => {
  try {
    const map = new Map();
    rides.forEach((r) => {
      const key = (r.destination || "").trim();
      if (!key) return;
      const entry = map.get(key) || {
        destination: key,
        count: 0,
        lat: r.destLat,
        lng: r.destLng,
      };
      entry.count += 1;
      if (
        (entry.lat === undefined || entry.lat === null) &&
        r.destLat !== undefined
      )
        entry.lat = r.destLat;
      if (
        (entry.lng === undefined || entry.lng === null) &&
        r.destLng !== undefined
      )
        entry.lng = r.destLng;
      map.set(key, entry);
    });
    const arr = Array.from(map.values()).sort((a, b) => b.count - a.count);
    res.json(arr);
  } catch (e) {
    res.status(500).json({ error: "Failed to compute destinations" });
  }
});

app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);
app.get("/rider", (req, res) => res.redirect("/"));

initSheets();

// Create HTTP server and attach Socket.IO for real-time events
const http = require("http");
const server = http.createServer(app);
const { Server: IOServer } = require("socket.io");
const io = new IOServer(server, { cors: { origin: "*" } });

io.on("connection", (socket) => {
  console.log("socket connected", socket.id);
});

// Start server
server.listen(PORT, () => {
  console.log(`Server (with Socket.IO) started on http://localhost:${PORT}`);
});
