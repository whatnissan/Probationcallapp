# Probation Drug Test Call App

An automated system that calls the drug testing hotline, navigates the IVR menu, and sends SMS notifications for **both outcomes** (test required OR no test required).

## Features

- 📞 Automated phone calls to drug testing hotline (+1 915-265-6476)
- 🔢 Automatic IVR navigation (Press 1 for English, enter PIN, confirm last name)
- 🎤 Speech recognition to detect test results
- 📱 **SMS notifications for BOTH outcomes** - so you always know the call completed
- 🌐 Web interface for easy configuration

## How It Works

1. Enter your 6-digit PIN and notification phone number
2. The app calls the hotline and automatically:
   - Waits for the language prompt (~5 seconds) and presses 1 for English
   - Waits for the PIN prompt (~10 seconds) and enters your 6-digit PIN
   - Waits for the last name confirmation (~10 seconds) and presses 1
   - Listens for the result message
3. **You receive an SMS either way:**
   - 🚨 `"DRUG TEST ALERT: You ARE REQUIRED to test today!"`
   - ✅ `"NO TEST TODAY: You do NOT need to test today."`
   - ⚠️ `"RESULT UNCLEAR: Please call manually to verify."`

## Setup

### Prerequisites

- [Node.js](https://nodejs.org/) 18 or higher
- A [Twilio](https://www.twilio.com/) account with:
  - A phone number capable of making calls and sending SMS
  - Account SID and Auth Token

### Local Development

1. Clone the repository:
   ```bash
   git clone https://github.com/YOUR_USERNAME/Probationcallapp.git
   cd Probationcallapp
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file from the template:
   ```bash
   cp .env.example .env
   ```

4. Edit `.env` with your Twilio credentials:
   ```
   TWILIO_ACCOUNT_SID=your_account_sid
   TWILIO_AUTH_TOKEN=your_auth_token
   TWILIO_PHONE_NUMBER=+15551234567
   BASE_URL=https://your-ngrok-url.ngrok.io
   ```

5. For local testing, use [ngrok](https://ngrok.com/) to expose your server:
   ```bash
   ngrok http 3000
   ```

6. Update `BASE_URL` in `.env` with your ngrok URL

7. Start the server:
   ```bash
   npm start
   ```

8. Open http://localhost:3000 in your browser

### Deploy to Railway

1. Push the code to your GitHub repository

2. Go to [Railway](https://railway.app/) and create a new project

3. Select "Deploy from GitHub repo" and choose your repository

4. Add environment variables in Railway dashboard:
   - `TWILIO_ACCOUNT_SID`
   - `TWILIO_AUTH_TOKEN`
   - `TWILIO_PHONE_NUMBER`
   - `BASE_URL` (set to your Railway app URL, e.g., `https://probationcallapp.up.railway.app`)

5. Deploy! Railway will automatically build and deploy your app

## Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `TWILIO_ACCOUNT_SID` | Your Twilio Account SID | `ACxxxxxxxx` |
| `TWILIO_AUTH_TOKEN` | Your Twilio Auth Token | `xxxxxxxxx` |
| `TWILIO_PHONE_NUMBER` | Your Twilio phone number | `+15551234567` |
| `BASE_URL` | Public URL of your app | `https://your-app.up.railway.app` |
| `PORT` | Server port (set automatically by Railway) | `3000` |

## API Endpoints

### POST /api/call-auto
Initiate an automated call with pre-timed DTMF sequence (recommended).

**Request Body:**
```json
{
  "targetNumber": "+1234567890",
  "pin": "123456",
  "notifyNumber": "+0987654321"
}
```

### POST /api/call
Initiate a call with speech-recognition-based navigation.

### GET /api/call/:callId
Check the status of a call.

## Timing Configuration

The app uses timed delays based on analysis of actual calls. Current timing:

| Step | Delay | Action |
|------|-------|--------|
| Initial greeting | 5 seconds | Wait, then press 1 for English |
| Spanish message + PIN prompt | 10 seconds | Wait, then enter 6-digit PIN |
| Last name prompt | 10 seconds | Wait, then press 1 to confirm |
| Listen for result | 15 seconds | Speech recognition for result |

If your drug testing hotline has different timing, adjust the pauses in `server.js`:

```javascript
// In /twiml/auto-navigate endpoint:
twiml.pause({ length: 5 });   // Wait for initial greeting
// ... press 1 for English ...
twiml.pause({ length: 10 });  // Wait for Spanish message and PIN prompt
// ... enter PIN ...
twiml.pause({ length: 10 });  // Wait for last name prompt
```

## Troubleshooting

### Call doesn't navigate correctly
- The IVR timing may differ. Adjust the `pause` lengths in the `/twiml/auto-navigate` endpoint
- Check the Twilio console logs for detailed call information

### Speech recognition not detecting result
- The app listens for keywords like "do not test", "required to test"
- You may need to add more keywords to the `KEYWORDS` object in `server.js`

### SMS not sending
- Verify your Twilio phone number can send SMS
- Check that the notification number format is correct (include country code)

## License

MIT

## Disclaimer

This app is for personal use to help manage probation requirements. Always verify test results by calling the hotline manually if in doubt.
