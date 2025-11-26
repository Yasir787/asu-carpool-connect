# ASU Carpool Demo

This is a lightweight demo web app to collect driver ride offers and save them to Google Sheets, and to display ride offers to riders.

Features

- Driver form at `/` to submit ride info.
- Rider page at `/rider` to view available rides.
- Backend API endpoints: `POST /api/driver` and `GET /api/rides`.
- Optional Google Sheets integration (service account).

Quick start

1. Install dependencies

```powershell
cd c:\Users\YASIR787\Downloads\asu_carpool\demo
npm install
```

2. Create a Google service account and share the spreadsheet

- Create a Google Cloud project and a service account with the **Google Sheets API** enabled.
- Create a credentials JSON for the service account.
- Create a Google Sheet and note its spreadsheet ID (part of the URL: `https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/...`).
- Share the sheet with the service account email (the `client_email` from the JSON).

3. Configure environment

You can set environment variables directly or use a `.env` file. Minimal variables:

- `GOOGLE_SHEET_ID` — your spreadsheet ID
- `GOOGLE_SERVICE_ACCOUNT_FILE` — path to the service account JSON file

Example `.env`:

```
GOOGLE_SHEET_ID=your_spreadsheet_id_here
GOOGLE_SERVICE_ACCOUNT_FILE=./sa.json
PORT=3000
```

Alternatively, set `GOOGLE_SERVICE_ACCOUNT_JSON` to the JSON text (not recommended for large JSON strings on Windows).

4. Run

```powershell
npm start
# or for development with auto reload
npm run dev
```

Open `http://localhost:3000/` for the driver form and `http://localhost:3000/rider` for riders.

Notes

- If Google credentials or sheet ID are missing, the app will still run but store data only in memory (demo mode).
- The server app appends rows to `Sheet1` — ensure `Sheet1` exists or change `server.js` append range.

Next steps I can do for you

- Add authentication for drivers and riders
- Use WebSockets for real-time updates instead of polling
- Add validation and nicer UI
- Deploy to a hosting provider (Render, Heroku, Azure, Vercel)
