import { task, schedules } from "@trigger.dev/sdk";
import { GoogleGenAI } from "@google/genai";
import nodemailer from "nodemailer";

// ─── Configuration ─────────────────────────────────────────────────────────────

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;

const EMAIL_CONFIG = {
  from: process.env.EMAIL_FROM!,
  to: process.env.EMAIL_TO!,
  smtp: {
    host: process.env.SMTP_HOST ?? "smtp.gmail.com",
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: false,
    auth: {
      user: process.env.SMTP_USER!,
      pass: process.env.SMTP_PASS!,
    },
  },
};

// ─── Category Definitions ──────────────────────────────────────────────────────

interface CategoryConfig {
  id: string;
  name: string;
  emoji: string;
  color: string;
  channels: { name: string; channelId: string }[];
  videoPrompt: string;         // Gemini prompt for individual video analysis
  collectionPrompt: string;    // Gemini prompt for the whole category summary
}

const CATEGORIES: CategoryConfig[] = [
  {
    id: "chess",
    name: "Chess",
    emoji: "♟️",
    color: "#2d6a4f",
    channels: [
      { name: "Anna Cramling",  channelId: "UCOVfq3NNYjlYCz1iou69FwQ" },
      { name: "Gotham Chess",   channelId: "UCQHX6ViZmPsWiYSFAyS0a3Q" },
      { name: "ChesswithAkeem", channelId: "UCRxtTeoTNe_gHxks1G5Jnjw" },
    ],
    videoPrompt: `You are a chess content analyst. Analyze this chess YouTube video based on its title and description.
Provide a concise analysis covering:
1. **Topic**: Opening theory, tactics, endgame, game review, or entertainment?
2. **Level**: Beginner / Intermediate / Advanced / All levels
3. **Key takeaway**: One sentence on what viewers will learn or enjoy
4. **Worth watching if**: Describe the ideal viewer for this video

Keep it under 80 words total. Be direct and informative.`,
    collectionPrompt: `You are a chess content curator. Below is a list of chess YouTube videos published today, each with an AI analysis.
Write a brief collection summary (3–4 sentences) that:
- Highlights the most interesting themes or patterns across today's chess content
- Notes any standout video or trend worth attention
- Gives an overall "vibe" of today's chess YouTube landscape

Be engaging, like a newsletter editor speaking to chess enthusiasts.`,
  },
  {
    id: "ai-tech",
    name: "AI & Tech",
    emoji: "🤖",
    color: "#1d3557",
    channels: [
      { name: "Nate Kerk",      channelId: "UC2ojq-nuP8ceeHqiroeKhBA" },
      { name: "Cole Medin",     channelId: "UCMwVTLZIRRUyyVrkjDpn4pA" },
      { name: "AI Revolution",  channelId: "UC5l7RouTQ60oUjLjt1Jnjw" },
    ],
    videoPrompt: `You are an AI/technology content analyst. Analyze this YouTube video based on its title and description.
Provide a concise analysis covering:
1. **Topic**: What AI concept, tool, model, or use-case is featured?
2. **Audience**: Developer / Researcher / Business / General public
3. **Key takeaway**: One sentence on the main insight or announcement
4. **Significance**: Why this matters right now (1 sentence)

Keep it under 80 words total. Be precise and technically aware.`,
    collectionPrompt: `You are an AI/tech content curator. Below is a list of AI & technology YouTube videos published today, each with an AI analysis.
Write a brief collection summary (3–4 sentences) that:
- Identifies the dominant themes in today's AI/tech content (e.g., new model releases, agent frameworks, tutorials)
- Points out any notable convergence or contrast between creators
- Gives readers a quick pulse on what the AI/tech community is focused on today

Be sharp and insightful, like a tech newsletter editor.`,
  },
];

// ─── Types ─────────────────────────────────────────────────────────────────────

interface Video {
  id: string;
  title: string;
  channelName: string;
  publishedAt: string;
  url: string;
  thumbnail: string;
  description: string;
}

interface VideoAnalysis {
  videoId: string;
  title: string;
  channelName: string;
  url: string;
  thumbnail: string;
  publishedAt: string;
  analysis: string;
}

interface CategoryResult {
  categoryId: string;
  categoryName: string;
  emoji: string;
  color: string;
  videoAnalyses: VideoAnalysis[];
  collectionSummary: string;
}

// ─── YouTube Helpers ───────────────────────────────────────────────────────────

async function getNewVideosForChannel(
  channelId: string,
  channelName: string,
  publishedAfter: string
): Promise<Video[]> {
  const searchUrl = new URL("https://www.googleapis.com/youtube/v3/search");
  searchUrl.searchParams.set("key", YOUTUBE_API_KEY);
  searchUrl.searchParams.set("channelId", channelId);
  searchUrl.searchParams.set("part", "snippet");
  searchUrl.searchParams.set("order", "date");
  searchUrl.searchParams.set("type", "video");
  searchUrl.searchParams.set("publishedAfter", publishedAfter);
  searchUrl.searchParams.set("maxResults", "10");

  const res = await fetch(searchUrl.toString());
  if (!res.ok) {
    throw new Error(`YouTube search API error for ${channelName}: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const items: any[] = data.items ?? [];
  if (items.length === 0) return [];

  // Fetch full descriptions via videos.list
  const videoIds = items.map((i: any) => i.id.videoId).join(",");
  const detailUrl = new URL("https://www.googleapis.com/youtube/v3/videos");
  detailUrl.searchParams.set("key", YOUTUBE_API_KEY);
  detailUrl.searchParams.set("id", videoIds);
  detailUrl.searchParams.set("part", "snippet");

  const detailRes = await fetch(detailUrl.toString());
  const detailData = detailRes.ok ? await detailRes.json() : { items: [] };
  const detailMap: Record<string, string> = {};
  for (const item of detailData.items ?? []) {
    detailMap[item.id] = item.snippet?.description ?? "";
  }

  return items.map((item: any) => ({
    id: item.id.videoId,
    title: item.snippet.title,
    channelName,
    publishedAt: item.snippet.publishedAt,
    url: `https://www.youtube.com/watch?v=${item.id.videoId}`,
    thumbnail: item.snippet.thumbnails?.medium?.url ?? "",
    description: (detailMap[item.id.videoId] ?? "").slice(0, 500),
  }));
}

// ─── Gemini Helper ─────────────────────────────────────────────────────────────

async function callGemini(prompt: string): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: prompt,
  });
  return response.text ?? "";
}

// ─── Sub-task: Analyze a single video ─────────────────────────────────────────

export const analyzeVideoTask = task({
  id: "analyze-video",
  retry: { maxAttempts: 3, minTimeoutInMs: 2000, maxTimeoutInMs: 15_000, factor: 2 },
  run: async (payload: {
    video: Video;
    categoryName: string;
    videoPrompt: string;
  }): Promise<VideoAnalysis> => {
    const { video, categoryName, videoPrompt } = payload;

    const prompt = `${videoPrompt}

---
Category: ${categoryName}
Channel: ${video.channelName}
Title: ${video.title}
Description: ${video.description || "(no description available)"}
---`;

    const analysis = await callGemini(prompt);

    return {
      videoId: video.id,
      title: video.title,
      channelName: video.channelName,
      url: video.url,
      thumbnail: video.thumbnail,
      publishedAt: video.publishedAt,
      analysis,
    };
  },
});

// ─── Sub-task: Analyze a full category collection ─────────────────────────────

export const analyzeCategoryTask = task({
  id: "analyze-category",
  retry: { maxAttempts: 2, minTimeoutInMs: 3000, maxTimeoutInMs: 20_000, factor: 2 },
  run: async (payload: {
    category: CategoryConfig;
    videos: Video[];
  }): Promise<CategoryResult> => {
    const { category, videos } = payload;

    console.log(`Analyzing ${videos.length} video(s) for category: ${category.name}`);

    // Analyze all videos in this category in parallel via batchTriggerAndWait
    const batchItems = videos.map((video) => ({
      payload: {
        video,
        categoryName: category.name,
        videoPrompt: category.videoPrompt,
      },
    }));

    const results = await analyzeVideoTask.batchTriggerAndWait(batchItems);

    const videoAnalyses: VideoAnalysis[] = [];
    for (const result of results.runs) {
      if (result.ok) {
        videoAnalyses.push(result.output);
      } else {
        console.error("Video analysis failed:", result.error);
      }
    }

    // Generate collection summary from all video analyses
    const analysesSummary = videoAnalyses
      .map(
        (va) =>
          `• [${va.channelName}] "${va.title}"\n  Analysis: ${va.analysis}`
      )
      .join("\n\n");

    const summaryPrompt = `${category.collectionPrompt}

---
Today's ${category.name} videos:

${analysesSummary}
---`;

    const collectionSummary = await callGemini(summaryPrompt);

    return {
      categoryId: category.id,
      categoryName: category.name,
      emoji: category.emoji,
      color: category.color,
      videoAnalyses,
      collectionSummary,
    };
  },
});

// ─── Email Builder ─────────────────────────────────────────────────────────────

function buildAdvancedEmailHtml(categoryResults: CategoryResult[], date: string): string {
  const totalVideos = categoryResults.reduce((sum, c) => sum + c.videoAnalyses.length, 0);

  const categoryBlocks = categoryResults
    .map((cat) => {
      const videoRows = cat.videoAnalyses
        .map(
          (v) => `
        <tr>
          <td style="padding:12px 8px;border-bottom:1px solid #f0f0f0;vertical-align:top;width:100px;">
            <a href="${v.url}" target="_blank">
              <img src="${v.thumbnail}" alt="" width="100" style="border-radius:5px;display:block;" />
            </a>
          </td>
          <td style="padding:12px 8px;border-bottom:1px solid #f0f0f0;vertical-align:top;">
            <div style="font-size:10px;color:${cat.color};font-weight:700;text-transform:uppercase;margin-bottom:3px;">
              ${v.channelName}
            </div>
            <a href="${v.url}" target="_blank"
               style="font-size:14px;font-weight:600;color:#111;text-decoration:none;line-height:1.3;">
              ${v.title}
            </a>
            <div style="font-size:11px;color:#888;margin-top:3px;">
              ${new Date(v.publishedAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}
            </div>
            <div style="font-size:12px;color:#444;margin-top:8px;padding:8px;background:#f9f9f9;border-left:3px solid ${cat.color};border-radius:0 4px 4px 0;line-height:1.5;">
              ${v.analysis.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>").replace(/\n/g, "<br/>")}
            </div>
          </td>
        </tr>`
        )
        .join("");

      return `
      <!-- Category: ${cat.categoryName} -->
      <div style="margin-bottom:32px;">
        <div style="background:${cat.color};padding:14px 20px;border-radius:8px 8px 0 0;">
          <h2 style="margin:0;color:#fff;font-size:17px;font-weight:700;">
            ${cat.emoji} ${cat.categoryName}
            <span style="font-size:12px;font-weight:400;opacity:.8;margin-left:8px;">
              ${cat.videoAnalyses.length} video${cat.videoAnalyses.length === 1 ? "" : "s"}
            </span>
          </h2>
        </div>

        <!-- Collection Summary -->
        <div style="background:#fff;border:1px solid #e0e0e0;border-top:none;padding:14px 20px;">
          <div style="font-size:11px;font-weight:700;color:${cat.color};text-transform:uppercase;margin-bottom:6px;">
            AI Collection Summary
          </div>
          <div style="font-size:13px;color:#333;line-height:1.6;font-style:italic;">
            ${cat.collectionSummary.replace(/\n/g, "<br/>")}
          </div>
        </div>

        <!-- Video list -->
        <div style="border:1px solid #e0e0e0;border-top:none;border-radius:0 0 8px 8px;overflow:hidden;">
          <table style="width:100%;border-collapse:collapse;">
            <tbody>${videoRows}</tbody>
          </table>
        </div>
      </div>`;
    })
    .join("");

  return `
  <!DOCTYPE html>
  <html>
  <head><meta charset="utf-8" /></head>
  <body style="margin:0;padding:0;background:#f0f2f5;font-family:Arial,sans-serif;">
    <div style="max-width:640px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.12);">

      <!-- Header -->
      <div style="background:linear-gradient(135deg,#1a1a2e 0%,#16213e 100%);padding:24px 28px;">
        <h1 style="margin:0;color:#fff;font-size:22px;font-weight:700;">
          📺 YouTube AI Digest
        </h1>
        <p style="margin:6px 0 0;color:rgba(255,255,255,.7);font-size:13px;">
          ${date} · ${totalVideos} video${totalVideos === 1 ? "" : "s"} analyzed by AI across ${categoryResults.length} categories
        </p>
      </div>

      <!-- Categories -->
      <div style="padding:20px 20px 8px;">
        ${categoryBlocks}
      </div>

      <!-- Footer -->
      <div style="padding:16px 24px;font-size:11px;color:#aaa;text-align:center;border-top:1px solid #eee;">
        Powered by Trigger.dev &amp; Gemini AI · Unsubscribe by removing this task
      </div>
    </div>
  </body>
  </html>`;
}

// ─── Main Scheduled Task ───────────────────────────────────────────────────────

export const youtubeDigestAdvanced = schedules.task({
  id: "youtube-digest-advanced",
  cron: "0 18 * * *",

  run: async (payload) => {
    const now = payload.timestamp;
    const startOfDay = new Date(now);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const publishedAfter = startOfDay.toISOString();

    console.log(`Advanced digest — checking videos published after: ${publishedAfter}`);

    // Fetch videos for every category in parallel
    const categoryVideoMap: Map<string, Video[]> = new Map();

    await Promise.allSettled(
      CATEGORIES.map(async (category) => {
        const channelResults = await Promise.allSettled(
          category.channels.map(({ name, channelId }) =>
            getNewVideosForChannel(channelId, name, publishedAfter)
          )
        );

        const videos: Video[] = [];
        for (const result of channelResults) {
          if (result.status === "fulfilled") {
            videos.push(...result.value);
          } else {
            console.error(`Channel fetch failed in ${category.name}:`, result.reason);
          }
        }

        videos.sort(
          (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
        );

        categoryVideoMap.set(category.id, videos);
        console.log(`Category "${category.name}": ${videos.length} video(s) found`);
      })
    );

    // Filter categories that have at least one video
    const categoriesWithVideos = CATEGORIES.filter(
      (cat) => (categoryVideoMap.get(cat.id) ?? []).length > 0
    );

    if (categoriesWithVideos.length === 0) {
      console.log("No new videos across any category — skipping.");
      return { sent: false, totalVideos: 0 };
    }

    // Analyze each category with Gemini via batchTriggerAndWait
    const batchItems = categoriesWithVideos.map((category) => ({
      payload: {
        category,
        videos: categoryVideoMap.get(category.id)!,
      },
    }));

    const analysisResults = await analyzeCategoryTask.batchTriggerAndWait(batchItems);

    const categoryResults: CategoryResult[] = [];
    for (const result of analysisResults.runs) {
      if (result.ok) {
        categoryResults.push(result.output);
      } else {
        console.error("Category analysis failed:", result.error);
      }
    }

    if (categoryResults.length === 0) {
      console.log("All category analyses failed — skipping email.");
      return { sent: false, totalVideos: 0 };
    }

    // Send email
    const transporter = nodemailer.createTransport(EMAIL_CONFIG.smtp);
    const dateLabel = startOfDay.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
    });

    const totalVideos = categoryResults.reduce((sum, c) => sum + c.videoAnalyses.length, 0);

    await transporter.sendMail({
      from: `"YouTube AI Digest" <${EMAIL_CONFIG.from}>`,
      to: EMAIL_CONFIG.to,
      subject: `🤖 ${totalVideos} video${totalVideos === 1 ? "" : "s"} analyzed — ${dateLabel}`,
      html: buildAdvancedEmailHtml(categoryResults, dateLabel),
    });

    console.log(`Email sent to ${EMAIL_CONFIG.to} with ${totalVideos} analyzed video(s)`);
    return { sent: true, totalVideos, categories: categoryResults.map((c) => c.categoryName) };
  },
});
