import { NextResponse } from "next/server";
import { getOpenAI } from "@/lib/openai";
import { fallback } from "@/lib/analyze";
import type { Settings } from "@/lib/types";

const DEFAULT_MODEL = "gpt-6-luna";

export async function POST(req: Request) {
  const body = (await req.json()) as { script?: string; settings?: Settings };
  const script = body.script?.trim() || "";

  if (script.length < 40) {
    return NextResponse.json({ error: "O roteiro é demasiado curto." }, { status: 400 });
  }

  const settings = body.settings || {
    language: "Português (Portugal)",
    voice: "marin",
    visualMode: "hybrid",
    aspectRatio: "16:9",
    resolution: "1080p",
    style: "Documentário",
    subtitles: true,
  };

  const ai = getOpenAI();

  if (!ai) {
    return NextResponse.json(fallback(script, settings));
  }

  try {
    const response = await ai.responses.create({
      model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
      input: [
        {
          role: "system",
          content:
            "You are the scene-planning engine of a professional long-form YouTube video editor. Return ONLY valid JSON. Preserve the user's narration exactly. Divide the script into meaningful visual scenes. Each scene should normally represent 3 to 8 seconds of narration. Use the requested language and style. Prefer visual variety and concrete, searchable subjects.",
        },
        {
          role: "user",
          content:
            `Create a storyboard for this YouTube script.

Return exactly this JSON shape:
{
  "title": "string",
  "summary": "string",
  "scenes": [
    {
      "narration": "exact text from the script",
      "duration": 4,
      "visualType": "stock|ai-image|ai-video|graphic|text",
      "visualPrompt": "detailed visual description",
      "searchQueries": ["query 1", "query 2"],
      "camera": "camera movement",
      "transition": "transition"
    }
  ]
}

Language: ${settings.language}
Style: ${settings.style}
Visual mode: ${settings.visualMode}
Aspect ratio: ${settings.aspectRatio}

SCRIPT:
${script}`,
        },
      ],
    });

    const parsed = JSON.parse(response.output_text);
    const scriptWordCount = script.split(/\s+/).filter(Boolean).length;

    const scenes = (parsed.scenes || []).map((s: any, i: number) => ({
      id: "scene-" + (i + 1),
      index: i + 1,
      narration: String(s.narration || ""),
      duration: Math.max(3, Number(s.duration) || 4),
      visualType: String(s.visualType || "stock"),
      visualPrompt: String(s.visualPrompt || ""),
      searchQueries: Array.isArray(s.searchQueries) ? s.searchQueries : [],
      camera: String(s.camera || "Slow cinematic push-in"),
      transition: String(s.transition || "Soft cut"),
    }));

    return NextResponse.json({
      title: String(parsed.title || "Novo vídeo"),
      summary: String(parsed.summary || ""),
      wordCount: scriptWordCount,
      estimatedDuration: scenes.reduce((total: number, s: Scene) => total + s.duration, 0),
      scenes,
      mode: "ai",
    });
  } catch (error) {
    console.error("Storyboard AI error:", error);
    return NextResponse.json(fallback(script, settings));
  }
}
