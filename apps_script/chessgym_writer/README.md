# ChessGym Sheets Writer

This Apps Script web app writes generated ChessGym study lines into the Google Sheet tabs used by the app:

- `openings`
- `lines`
- `nodes`

## Deploy

1. Create a new Apps Script project at <https://script.google.com/>.
2. Add `Code.gs` and `appsscript.json` from this folder.
3. Run `setupScriptProperties` once, then open Project Settings > Script properties and set:
   - `SPREADSHEET_ID`: the spreadsheet ID from the Google Sheets URL.
   - `ALLOWED_EMAILS`: comma-separated Google accounts allowed to write.
   - `WRITE_TOKEN`: optional fallback token. Leave blank if Google account auth is enough.
4. Deploy > New deployment > Web app.
5. Use these deployment settings for Google-account auth:
   - Execute as: `User accessing the web app`
   - Who has access: `Anyone with Google account`
6. Copy the `/exec` URL.
7. In `app.js`, paste that URL into `WRITE_WEB_APP_URL` near the top of the file:

```js
const WRITE_WEB_APP_URL = "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec";
const WRITE_TOKEN = "";
```

## Auth Modes

The recommended path is Google auth with `ALLOWED_EMAILS`. The web app runs as the signed-in user, so that account must be allowed by the script and must be able to write the spreadsheet.

The optional `WRITE_TOKEN` path is for owner-run or simpler personal deployments. If ChessGym is served anywhere public, avoid putting a real token in `app.js`; browser JavaScript can always be inspected. Prefer Google account auth with `ALLOWED_EMAILS`.

## Health Check

Open:

```text
https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec?health=1
```

The response shows whether the endpoint is alive and which Google identity Apps Script can see.
