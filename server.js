require("dotenv").config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const { google } = require("googleapis");

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;

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

  const ride = {
    id: Date.now().toString(),
    name,
    email: email || "",
    phone: phone || "",
    origin,
    destination,
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

  const reqObj = {
    id: Date.now().toString(),
    rideId,
    rideDriverEmail: ride.email || "",
    name,
    email,
    phone: phone || "",
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

  return res.json({ ok: true, request: reqObj });
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

app.get("/api/rides", (req, res) => {
  res.json(rides);
});

app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "driver.html"))
);
app.get("/rider", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "rider.html"))
);

initSheets();

app.listen(PORT, () => {
  console.log(`Server started on http://localhost:${PORT}`);
});
