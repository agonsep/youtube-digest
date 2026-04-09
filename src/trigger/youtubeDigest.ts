import { schedules } from "@trigger.dev/sdk/v3";
import nodemailer from "nodemailer";

// ─── Configuration ────────────────────────────────────────────────────────────

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY!;

const CHANNELS_TO_WATCH: { name: string; channelId: string }[] = [  
  { name: "Anna Cramling",        channelId: "UCOVfq3NNYjlYCz1iou69FwQ" },
  { name: "Gotham Chess",        channelId: "UCQHX6ViZmPsWiYSFAyS0a3Q" },
  { name: "Nate Kerk",   channelId: "UC2ojq-nuP8ceeHqiroeKhBA" },
  { name: "Cole Medin",   channelId: "UCMwVTLZIRRUyyVrkjDpn4pA" },  
  { name: "AI Revolution", channelId: "UC5l7RouTQ60oUjLjt1Nh-UQ" },
  { name: "ChesswithAkeem", channelId: "UCRxtTeoTNe_gHxks1G5Jnjw" },
];

const EMAIL_CONFIG = {
  from: process.env.EMAIL_FROM!,       // e.g. "you@gmail.com"
  to:   process.env.EMAIL_TO!,         // e.g. "you@gmail.com"
  smtp: {
    host:   process.env.SMTP_HOST ?? "smtp.gmail.com",
    port:   Number(process.env.SMTP_PORT ?? 587),
    secure: false,
    auth: {
      user: process.env.SMTP_USER!,    // Gmail address
      pass: process.env.SMTP_PASS!,    // Gmail App Password (not your real password)
    },
  },
};

// ─── Types ────────────────────────────────────────────────────────────────────

interface Video {
  id: string;
  title: string;
  channelName: string;
  publishedAt: string;
  url: string;
  thumbnail: string;
}

// ─── YouTube Helpers ──────────────────────────────────────────────────────────

async function getNewVideosForChannel(
  channelId: string,
  channelName: string,
  publishedAfter: string
): Promise<Video[]> {
  const url = new URL("https://www.googleapis.com/youtube/v3/search");
  url.searchParams.set("key", YOUTUBE_API_KEY);
  url.searchParams.set("channelId", channelId);
  url.searchParams.set("part", "snippet");
  url.searchParams.set("order", "date");
  url.searchParams.set("type", "video");
  url.searchParams.set("publishedAfter", publishedAfter);
  url.searchParams.set("maxResults", "10");

  const res = await fetch(url.toString());
  if (!res.ok) {
    throw new Error(`YouTube API error for ${channelName}: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();

  return (data.items ?? []).map((item: any) => ({
    id: item.id.videoId,
    title: item.snippet.title,
    channelName,
    publishedAt: item.snippet.publishedAt,
    url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
    thumbnail: item.snippet.thumbnails?.medium?.url ?? "",
  }));
}

// ─── Email Builder ────────────────────────────────────────────────────────────

function buildEmailHtml(videos: Video[], date: string): string {
  const rows = videos
    .map(
      (v) => `
      <tr>
        <td style="padding:12px 8px;border-bottom:1px solid #eee;vertical-align:top;width:120px;">
          <a href="${v.url}" target="_blank">
            <img src="${v.thumbnail}" alt="" width="120" style="border-radius:6px;display:block;" />
          </a>
        </td>
        <td style="padding:12px 8px;border-bottom:1px solid #eee;vertical-align:top;">
          <div style="font-size:11px;color:#e00;font-weight:600;text-transform:uppercase;margin-bottom:4px;">
            ${v.channelName}
          </div>
          <a href="${v.url}" target="_blank"
             style="font-size:15px;font-weight:600;color:#111;text-decoration:none;line-height:1.3;">
            ${v.title}
          </a>
          <div style="font-size:11px;color:#888;margin-top:4px;">
            ${new Date(v.publishedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
          </div>
        </td>
      </tr>`
    )
    .join("");

  return `
  <!DOCTYPE html>
  <html>
  <head><meta charset="utf-8" /></head>
  <body style="margin:0;padding:0;background:#f4f4f4;font-family:Arial,sans-serif;">
    <div style="max-width:600px;margin:32px auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.1);">
      <div style="background:#ff0000;padding:20px 24px;">
        <h1 style="margin:0;color:#fff;font-size:20px;">
          📺 YouTube Daily Digest — ${date}
        </h1>
        <p style="margin:6px 0 0;color:rgba(255,255,255,.85);font-size:13px;">
          ${videos.length} new video${videos.length === 1 ? "" : "s"} from your watched channels
        </p>
      </div>
      <table style="width:100%;border-collapse:collapse;padding:8px;">
        <tbody>${rows}</tbody>
      </table>
      <div style="padding:16px 24px;font-size:11px;color:#aaa;text-align:center;">
        Powered by Trigger.dev · Unsubscribe by removing this task
      </div>
    </div>
  </body>
  </html>`;
}

// ─── The Scheduled Task ───────────────────────────────────────────────────────

export const youtubeDigest = schedules.task({
  id: "youtube-daily-digest",

  // Runs every day at 6 PM UTC — adjust to your timezone
  // Cron syntax: minute hour day month weekday
  cron: "0 18 * * *",

  run: async (payload) => {
    const now = payload.timestamp;           // scheduled fire time
    const startOfDay = new Date(now);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const publishedAfter = startOfDay.toISOString();

    console.log(`Checking for videos published after: ${publishedAfter}`);

    // Fetch new videos from all channels in parallel
    const results = await Promise.allSettled(
      CHANNELS_TO_WATCH.map(({ name, channelId }) =>
        getNewVideosForChannel(channelId, name, publishedAfter)
      )
    );

    const allVideos: Video[] = [];
    for (const result of results) {
      if (result.status === "fulfilled") {
        allVideos.push(...result.value);
      } else {
        console.error("Channel fetch failed:", result.reason);
      }
    }

    // Sort by publish time, newest first
    allVideos.sort(
      (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
    );

    console.log(`Found ${allVideos.length} new video(s) today.`);

    if (allVideos.length === 0) {
      console.log("No new videos — skipping email.");
      return { sent: false, videoCount: 0 };
    }

    // Send email
    const transporter = nodemailer.createTransport(EMAIL_CONFIG.smtp);
    const dateLabel = startOfDay.toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric",
    });

    await transporter.sendMail({
      from: `"YouTube Digest" <${EMAIL_CONFIG.from}>`,
      to:   EMAIL_CONFIG.to,
      subject: `📺 ${allVideos.length} new video${allVideos.length === 1 ? "" : "s"} today — ${dateLabel}`,
      html: buildEmailHtml(allVideos, dateLabel),
    });

    console.log(`Email sent to ${EMAIL_CONFIG.to}`);
    return { sent: true, videoCount: allVideos.length };
  },
});
