import { NextResponse } from "next/server";
import { getOpenAI } from "@/lib/openai";

export async function POST(req: Request) {
  const body = (await req.json()) as { text?: string; voice?: string; speed?: number };
  const text = String(body.text || "").trim();

  if (!text) return NextResponse.json({ error: "Texto em falta." }, { status: 400 });

  if (text.length > 4096) {
    return NextResponse.json({
      error: "Esta cena é demasiado longa para uma única geração de voz. O limite deste endpoint é 4096 caracteres.",
    }, { status: 400 });
  }

  const ai = getOpenAI();
  if (!ai) return NextResponse.json({ error: "Configure OPENAI_API_KEY." }, { status: 503 });

  try {
    const audio = await ai.audio.speech.create({
      model: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
      voice: body.voice || process.env.OPENAI_TTS_VOICE || "marin",
      input: text,
      instructions:
        "European Portuguese (Portugal) pronunciation only. Never use Brazilian Portuguese pronunciation. " +
        "Natural male narrator, documentary style, confident, warm, clear articulation, moderate pace.",
      response_format: "mp3",
      speed: Math.max(0.25, Math.min(4, Number(body.speed) || 1)),
    });

    return new Response(await audio.arrayBuffer(), {
      headers: {
        "Content-Type": "audio/mpeg",
        "Cache-Control": "no-store",
        "X-AI-Voice-Disclosure": "AI-generated voice",
      },
    });
  } catch (error) {
    console.error("TTS error:", error);
    return NextResponse.json({ error: "A geração de voz falhou." }, { status: 502 });
  }
}
