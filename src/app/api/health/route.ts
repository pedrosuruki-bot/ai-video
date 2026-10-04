import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    configured: {
      openai: Boolean(process.env.OPENAI_API_KEY),
      imageModel: process.env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-flare",
      ttsModel: process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts",
      ttsVoice: process.env.OPENAI_TTS_VOICE || "marin",
      stock: true,
      render: Boolean(process.env.CREATOMATE_API_KEY),
    },
    note: "Use /api/diagnostics for live provider availability. Configuration alone does not prove provider availability.",
    timestamp: new Date().toISOString(),
  });
}
