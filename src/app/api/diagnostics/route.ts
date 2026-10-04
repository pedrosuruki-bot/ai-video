import { NextResponse } from "next/server";
import { getOpenAI } from "@/lib/openai";

async function checkModel(ai: any, model: string) {
  try {
    await ai.models.retrieve(model);
    return { configured: true, available: true, model };
  } catch (error) {
    return {
      configured: true,
      available: false,
      model,
      error: String(error instanceof Error ? error.message : error),
    };
  }
}

async function checkStock() {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const params = new URLSearchParams({
      action: "query",
      generator: "search",
      gsrsearch: "nature",
      gsrnamespace: "6",
      gsrlimit: "1",
      prop: "imageinfo",
      iiprop: "url|mime",
      format: "json",
      origin: "*",
    });
    const response = await fetch("https://commons.wikimedia.org/w/api.php?" + params.toString(), {
      headers: { "User-Agent": "AI-Video-Factory/1.0 (diagnostics)" },
      cache: "no-store",
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!response.ok) return { available: false, error: "HTTP " + response.status };
    const data = await response.json();
    const pages = Object.values((data?.query?.pages || {}) as Record<string, any>);
    return { available: pages.length > 0 };
  } catch (error) {
    return {
      available: false,
      error: String(error instanceof Error ? error.message : error),
    };
  }
}

export async function GET() {
  const openaiConfigured = Boolean(process.env.OPENAI_API_KEY);
  const imageModel = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-flare";
  const ttsModel = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
  const ttsVoice = process.env.OPENAI_TTS_VOICE || "marin";

  if (!openaiConfigured) {
    return NextResponse.json({
      status: "degraded",
      openai: { configured: false, reachable: false },
      image: { available: false, model: imageModel, error: "OPENAI_API_KEY em falta." },
      tts: { available: false, model: ttsModel, voice: ttsVoice, error: "OPENAI_API_KEY em falta." },
      stock: await checkStock(),
      timestamp: new Date().toISOString(),
    });
  }

  const ai = getOpenAI();
  const [image, tts, stock] = await Promise.all([
    checkModel(ai, imageModel),
    checkModel(ai, ttsModel),
    checkStock(),
  ]);

  return NextResponse.json({
    status: image.available && tts.available && stock.available ? "ready" : "degraded",
    openai: {
      configured: true,
      reachable: image.available || tts.available,
    },
    image,
    tts: { ...tts, voice: ttsVoice },
    stock,
    timestamp: new Date().toISOString(),
  });
}
