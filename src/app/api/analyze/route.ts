import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 90;
import { getOpenAI } from "@/lib/openai";
import { fallback } from "@/lib/analyze";
import type { Settings, Scene } from "@/lib/types";

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
  if (!ai) return NextResponse.json(fallback(script, settings));

  try {
    const response = await ai.responses.create({
      model: process.env.OPENAI_MODEL || DEFAULT_MODEL,
      input: [
        {
          role: "system",
          content:
            "You are the scene-planning engine of a professional long-form YouTube video editor. " +
            "Return ONLY valid JSON. Preserve the user's narration exactly. " +
            "Divide the script into meaningful visual scenes. Each scene should normally represent 4 to 8 seconds of narration. " +
            "Create visual variety, avoid repetitive generic footage, prefer concrete searchable subjects, and keep narration unchanged. " +
            "For Portuguese (Portugal), keep European Portuguese text exactly as supplied.",
        },
        {
          role: "user",
          content:
            "Create a production storyboard. Return exactly this JSON object with title, summary and scenes. " +
            "Each scene must have narration, duration, visualType (stock|ai-image|ai-video|graphic|text), " +
            "visualPrompt, searchQueries (array), camera, and transition. " +
            "Language: " + settings.language + ". Style: " + settings.style + ". Visual mode: " + settings.visualMode + ". " +
            "Aspect ratio: " + settings.aspectRatio + ".\n\nSCRIPT:\n" + script,
        },
      ],
    });

    const parsed = JSON.parse(response.output_text);
    const scriptWordCount = script.split(/\s+/).filter(Boolean).length;

    const scenes: Scene[] = (parsed.scenes || []).map((s: any, i: number) => ({
      id: "scene-" + (i + 1),
      index: i + 1,
      narration: String(s.narration || ""),
      duration: Math.max(3, Number(s.duration) || 5),
      visualType: String(s.visualType || "stock"),
      visualPrompt: String(s.visualPrompt || s.narration || ""),
      searchQueries: Array.isArray(s.searchQueries) ? s.searchQueries.map(String) : [],
      camera: String(s.camera || "Slow cinematic push-in"),
      transition: String(s.transition || "Soft cut"),
    }));

    return NextResponse.json({
      title: String(parsed.title || "Novo vídeo"),
      summary: String(parsed.summary || ""),
      wordCount: scriptWordCount,
      estimatedDuration: scenes.reduce((total, scene) => total + scene.duration, 0),
      scenes,
      mode: "ai",
    });
  } catch (error) {
    console.error("Storyboard AI error:", error);
    return NextResponse.json(fallback(script, settings));
  }
}
