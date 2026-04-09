import { task, schedules } from "@trigger.dev/sdk";
import { GoogleGenAI } from "@google/genai";
import { TwitterApi } from "twitter-api-v2";

// ─── Configuration ─────────────────────────────────────────────────────────────

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY!;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY!;

const AI_TECH_CHANNELS = [
  { name: "Nate Kerk",       channelId: "UC2ojq-nuP8ceeHqiroeKhBA" },
  { name: "Cole Medin",      channelId: "UCMwVTLZIRRUyyVrkjDpn4pA" },
  { name: "AI Revolution",   channelId: "UC5l7RouTQ60oUjLjt1Jnjw" },
  { name: "Claudius Papirus", channelId: "UCYhgVUxsl1PQUOMufZ8I5uQ" },
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
  title: string;
  channelName: string;
  url: string;
  analysis: string;
}

interface DigestPayload {
  date: string;
  collectionSummary: string;
  videoAnalyses: VideoAnalysis[];
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
  searchUrl.searchParams.set("maxResults", "5");

  const res = await fetch(searchUrl.toString());
  if (!res.ok) throw new Error(`YouTube API error: ${res.status}`);

  const data = await res.json();
  const items: any[] = data.items ?? [];
  if (items.length === 0) return [];

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

// ─── Sub-task: Post to Twitter/X as a thread ──────────────────────────────────

export const postToTwitterTask = task({
  id: "post-to-twitter",
  retry: { maxAttempts: 3, minTimeoutInMs: 5000, maxTimeoutInMs: 30_000, factor: 2 },
  run: async (payload: DigestPayload) => {
    const prompt = `You are writing a Twitter/X thread about today's AI & tech YouTube videos.

Rules:
- Tweet 1: A punchy hook that grabs attention (max 240 chars). Mention it's a thread with "🧵".
- Tweet 2: The collection summary rewritten for Twitter — concise, energetic (max 240 chars).
- Tweet 3 onwards: One tweet per video (max 220 chars each, leaving room for the URL). Include the video URL at the end of each tweet.
- Final tweet: A closing thought + relevant hashtags like #AI #MachineLearning #Tech (max 240 chars).
- Use emojis sparingly but effectively.
- Output ONLY a JSON array of tweet strings, no explanation. Example: ["tweet 1", "tweet 2", ...]

Today's date: ${payload.date}
Collection summary: ${payload.collectionSummary}

Videos:
${payload.videoAnalyses.map((v) => `- "${v.title}" by ${v.channelName}\n  Analysis: ${v.analysis}\n  URL: ${v.url}`).join("\n\n")}`;

    const raw = await callGemini(prompt);
    const jsonMatch = raw.match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error("Gemini did not return a valid JSON array for Twitter");

    const tweets: string[] = JSON.parse(jsonMatch[0]);

    const client = new TwitterApi({
      appKey:       process.env.TWITTER_API_KEY!,
      appSecret:    process.env.TWITTER_API_SECRET!,
      accessToken:  process.env.TWITTER_ACCESS_TOKEN!,
      accessSecret: process.env.TWITTER_ACCESS_SECRET!,
    });

    // Post first tweet, then reply to build the thread
    let lastTweetId: string | undefined;
    for (const text of tweets) {
      const posted = await client.v2.tweet({
        text,
        ...(lastTweetId ? { reply: { in_reply_to_tweet_id: lastTweetId } } : {}),
      });
      lastTweetId = posted.data.id;
    }

    console.log(`Twitter thread posted — ${tweets.length} tweets`);
    return { platform: "twitter", tweets: tweets.length, firstTweetId: lastTweetId };
  },
});

// ─── Sub-task: Post to LinkedIn ───────────────────────────────────────────────

export const postToLinkedInTask = task({
  id: "post-to-linkedin",
  retry: { maxAttempts: 3, minTimeoutInMs: 5000, maxTimeoutInMs: 30_000, factor: 2 },
  run: async (payload: DigestPayload) => {
    const prompt = `You are writing a LinkedIn post about today's AI & tech YouTube content.

Tone: Professional, insightful, thought-leadership. Written in first person as a curious tech professional.
Length: 200–350 words.
Structure:
- Opening hook (1–2 sentences that make people stop scrolling)
- Key insights from today's videos (3–5 bullet points, each tied to a specific video with its title and a brief takeaway)
- Closing reflection or question to drive comments
- 3–5 relevant hashtags on the last line

Do NOT include raw URLs in the body — LinkedIn deprioritizes posts with links. Mention video titles naturally instead.
Output ONLY the post text, no explanation.

Today's date: ${payload.date}
Collection summary: ${payload.collectionSummary}

Videos:
${payload.videoAnalyses.map((v) => `- "${v.title}" by ${v.channelName}\n  Analysis: ${v.analysis}`).join("\n\n")}`;

    const post = await callGemini(prompt);

    const accessToken = process.env.LINKEDIN_ACCESS_TOKEN!;
    const authorUrn   = process.env.LINKEDIN_AUTHOR_URN!; // e.g. "urn:li:person:abc123" or "urn:li:organization:123"

    const res = await fetch("https://api.linkedin.com/v2/ugcPosts", {
      method: "POST",
      headers: {
        Authorization:  `Bearer ${accessToken}`,
        "Content-Type": "application/json",
        "X-Restli-Protocol-Version": "2.0.0",
      },
      body: JSON.stringify({
        author: authorUrn,
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text: post },
            shareMediaCategory: "NONE",
          },
        },
        visibility: {
          "com.linkedin.ugc.MemberNetworkVisibility": "PUBLIC",
        },
      }),
    });

    if (!res.ok) {
      throw new Error(`LinkedIn API error: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    console.log("LinkedIn post published:", data.id);
    return { platform: "linkedin", postId: data.id };
  },
});

// ─── Sub-task: Post to Facebook ───────────────────────────────────────────────

export const postToFacebookTask = task({
  id: "post-to-facebook",
  retry: { maxAttempts: 3, minTimeoutInMs: 5000, maxTimeoutInMs: 30_000, factor: 2 },
  run: async (payload: DigestPayload) => {
    const prompt = `You are writing a Facebook post about today's AI & tech YouTube videos.

Tone: Conversational, curious, enthusiastic — like sharing cool finds with friends who are into tech.
Length: 150–250 words.
Structure:
- Fun opening line with an emoji
- 3–4 highlights from today's videos (casual, not bullet points — flow naturally)
- Include YouTube URLs for the top 2–3 videos naturally in the text
- End with an engaging question or call to action
- 2–3 hashtags max

Output ONLY the post text, no explanation.

Today's date: ${payload.date}
Collection summary: ${payload.collectionSummary}

Videos:
${payload.videoAnalyses.map((v) => `- "${v.title}" by ${v.channelName}\n  Analysis: ${v.analysis}\n  URL: ${v.url}`).join("\n\n")}`;

    const post = await callGemini(prompt);

    const pageId          = process.env.FACEBOOK_PAGE_ID!;
    const pageAccessToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN!;

    const res = await fetch(
      `https://graph.facebook.com/v21.0/${pageId}/feed`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message:      post,
          access_token: pageAccessToken,
        }),
      }
    );

    if (!res.ok) {
      throw new Error(`Facebook API error: ${res.status} ${await res.text()}`);
    }

    const data = await res.json();
    console.log("Facebook post published:", data.id);
    return { platform: "facebook", postId: data.id };
  },
});

// ─── Main Scheduled Task ───────────────────────────────────────────────────────

export const aiSocialDigest = schedules.task({
  id: "ai-social-digest",
  cron: "0 18 * * *",

  run: async (payload) => {
    const now = payload.timestamp;
    const startOfDay = new Date(now);
    startOfDay.setUTCHours(0, 0, 0, 0);
    const publishedAfter = startOfDay.toISOString();

    const dateLabel = startOfDay.toLocaleDateString("en-US", {
      weekday: "long", month: "long", day: "numeric",
    });

    console.log(`AI Social Digest — checking videos published after: ${publishedAfter}`);

    // Fetch videos from all AI channels in parallel
    const channelResults = await Promise.allSettled(
      AI_TECH_CHANNELS.map(({ name, channelId }) =>
        getNewVideosForChannel(channelId, name, publishedAfter)
      )
    );

    const videos: Video[] = [];
    for (const result of channelResults) {
      if (result.status === "fulfilled") videos.push(...result.value);
      else console.error("Channel fetch failed:", result.reason);
    }

    videos.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());

    console.log(`Found ${videos.length} AI video(s) today`);

    if (videos.length === 0) {
      console.log("No new AI videos today — skipping social posts.");
      return { posted: false, videoCount: 0 };
    }

    // Analyze each video with Gemini
    const videoPrompt = `You are an AI/technology content analyst. Analyze this YouTube video based on its title and description.
Provide a concise analysis covering:
1. **Topic**: What AI concept, tool, model, or use-case is featured?
2. **Audience**: Developer / Researcher / Business / General public
3. **Key takeaway**: One sentence on the main insight or announcement
4. **Significance**: Why this matters right now (1 sentence)
Keep it under 80 words total.`;

    const videoAnalyses: VideoAnalysis[] = [];
    for (const video of videos) {
      const prompt = `${videoPrompt}

---
Channel: ${video.channelName}
Title: ${video.title}
Description: ${video.description || "(no description available)"}
---`;
      const analysis = await callGemini(prompt);
      videoAnalyses.push({
        title:       video.title,
        channelName: video.channelName,
        url:         video.url,
        analysis,
      });
    }

    // Generate collection summary
    const summaryPrompt = `You are an AI/tech content curator. Below is a list of AI & technology YouTube videos published today, each with an AI analysis.
Write a brief collection summary (3–4 sentences) that identifies dominant themes, notable content, and the overall pulse of the AI/tech YouTube space today.

${videoAnalyses.map((v) => `• [${v.channelName}] "${v.title}"\n  ${v.analysis}`).join("\n\n")}`;

    const collectionSummary = await callGemini(summaryPrompt);

    const digestPayload: DigestPayload = {
      date: dateLabel,
      collectionSummary,
      videoAnalyses,
    };

    // Fire off all three social posts independently (no need to wait)
    await Promise.all([
      postToTwitterTask.trigger(digestPayload),
      postToLinkedInTask.trigger(digestPayload),
      postToFacebookTask.trigger(digestPayload),
    ]);

    console.log("All social post tasks triggered");
    return { posted: true, videoCount: videos.length, platforms: ["twitter", "linkedin", "facebook"] };
  },
});
