# 📺 YouTube Daily Digest — Trigger.dev Task

Checks your favourite YouTube channels once a day and emails you a digest of any new videos.

---

## Prerequisites

- [Trigger.dev account](https://trigger.dev) (free tier works)
- YouTube Data API v3 key (free, ~10k units/day quota)
- Gmail account with an **App Password** enabled (or swap nodemailer for SendGrid/Resend)

---

## Setup

### 1. Clone / copy this folder into your project

```
your-project/
├── src/trigger/youtubeDigest.ts
├── trigger.config.ts
├── package.json
└── .env
```

### 2. Install dependencies

```bash
npm install
```

### 3. Get a YouTube API Key

1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project → **APIs & Services** → **Enable APIs**
3. Enable **YouTube Data API v3**
4. **Credentials** → **Create API Key** → copy it

### 4. Get a Gmail App Password

1. Go to your Google Account → **Security** → **2-Step Verification** (must be on)
2. **App passwords** → generate one for "Mail"
3. Copy the 16-character password

### 5. Create your `.env` file

```env
TRIGGER_SECRET_KEY=tr_dev_xxxxxxxxxxxx   # from Trigger.dev dashboard → API Keys

YOUTUBE_API_KEY=AIzaSy...

EMAIL_FROM=you@gmail.com
EMAIL_TO=you@gmail.com
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=xxxx xxxx xxxx xxxx            # Gmail App Password
```

### 6. Update `trigger.config.ts`

Replace `your-trigger-project-ref` with your project ref from the Trigger.dev dashboard.

### 7. Add your channels

In `src/trigger/youtubeDigest.ts`, edit the `CHANNELS_TO_WATCH` array:

```ts
const CHANNELS_TO_WATCH = [
  { name: "Fireship",   channelId: "UCsBjURrPoezykLs9EqgamOA" },
  { name: "My Channel", channelId: "UC..." },
];
```

**Finding a channel ID:** go to the channel on YouTube → View Page Source → Ctrl+F `channelId`.
Or use https://commentpicker.com/youtube-channel-id.php

### 8. Run in dev mode (test it now)

```bash
npm run dev
```

This opens the Trigger.dev dev tunnel. In the dashboard, find the task and click **Test** to fire it immediately.

### 9. Deploy

```bash
npm run deploy
```

The task will run automatically every day at 6 PM UTC (customize the `cron` line).

---

## Customising the Schedule

Edit the `cron` field in `youtubeDigest.ts`:

```ts
cron: "0 18 * * *"   // 6 PM UTC daily
cron: "0 8 * * *"    // 8 AM UTC daily
cron: "0 9 * * 1-5"  // 9 AM UTC weekdays only
```

Use [crontab.guru](https://crontab.guru) to build expressions.

---

## Swapping the Email Provider

Replace the `nodemailer` block with [Resend](https://resend.com) (recommended for simplicity):

```bash
npm install resend
```

```ts
import { Resend } from "resend";
const resend = new Resend(process.env.RESEND_API_KEY);
await resend.emails.send({ from, to, subject, html });
```
