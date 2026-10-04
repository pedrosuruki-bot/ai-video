import { NextResponse } from "next/server";
import { getOpenAI } from "@/lib/openai";

function classifyTtsError(error: any) {
  const status = Number(error?.status || error?.statusCode || 0);
  const message = String(error?.message || error || "Erro desconhecido.");
  const lower = message.toLowerCase();

  if (status === 401 || status === 403 || /invalid.*key|api key|authentication|unauthorized/.test(lower)) {
    return { code: "TTS_AUTH_ERROR", message: "A autenticação da OpenAI falhou.", retryable: false };
  }
  if (status === 429 || /rate limit|quota|billing|credit|insufficient|spend limit/.test(lower)) {
    return {
      code: /billing|credit|quota|spend/.test(lower) ? "TTS_BILLING_ERROR" : "TTS_RATE_LIMIT",
      message: "A OpenAI recusou a geração de voz por limite, quota ou billing.",
      retryable: status === 429,
    };
  }
  if (/model.*(not found|does not exist|unavailable)|unknown model/.test(lower)) {
    return { code: "TTS_MODEL_UNAVAILABLE", message: "O modelo TTS configurado não está disponível.", retryable: false };
  }
  if (/voice.*(not found|invalid|unavailable)/.test(lower)) {
    return { code: "TTS_VOICE_UNAVAILABLE", message: "A voz configurada não está disponível.", retryable: false };
  }
  if (status >= 500 || /timeout|timed out|network|fetch failed|temporar/.test(lower)) {
    return { code: "TTS_PROVIDER_ERROR", message: "O serviço de voz teve um erro temporário.", retryable: true };
  }
  return { code: "TTS_PROVIDER_ERROR", message, retryable: false };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function POST(req: Request) {
  const body = (await req.json()) as { text?: string; voice?: string; speed?: number };
  const text = String(body.text || "").trim();

  if (!text) {
    return NextResponse.json({ error: "Texto em falta.", code: "TTS_INPUT_ERROR", stage: "audio" }, { status: 400 });
  }

  if (text.length > 4096) {
    return NextResponse.json({
      error: "Esta cena é demasiado longa para uma única geração de voz. O limite deste endpoint é 4096 caracteres.",
      code: "TTS_INPUT_TOO_LONG",
      stage: "audio",
    }, { status: 400 });
  }

  const ai = getOpenAI();
  if (!ai) {
    return NextResponse.json({
      error: "Configure OPENAI_API_KEY.",
      code: "TTS_AUTH_ERROR",
      stage: "audio",
    }, { status: 503 });
  }

  const model = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
  const voice = body.voice || process.env.OPENAI_TTS_VOICE || "marin";
  let lastError: any = null;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const audio = await ai.audio.speech.create({
        model,
        voice,
        input: text,
        instructions:
          "European Portuguese (Portugal) pronunciation only. Never use Brazilian Portuguese pronunciation. " +
          "Natural male narrator, documentary style, confident, warm, clear articulation, moderate pace.",
        response_format: "mp3",
        speed: Math.max(0.25, Math.min(4, Number(body.speed) || 1)),
      });

      const buffer = await audio.arrayBuffer();
      if (!buffer.byteLength) throw new Error("A API devolveu um áudio vazio.");

      return new Response(buffer, {
        headers: {
          "Content-Type": "audio/mpeg",
          "Cache-Control": "no-store",
          "X-AI-Voice-Disclosure": "AI-generated voice",
        },
      });
    } catch (error) {
      lastError = error;
      const classified = classifyTtsError(error);
      console.error("TTS error", {
        code: classified.code,
        message: classified.message,
        status: Number((error as any)?.status || 0),
        model,
        voice,
      });
      if (!classified.retryable || attempt === 1) break;
      await sleep(700);
    }
  }

  const classified = classifyTtsError(lastError);
  return NextResponse.json({
    error: classified.message,
    code: classified.code,
    stage: "audio",
    provider: "OpenAI",
    retryable: classified.retryable,
    detail: String(lastError?.message || lastError || "Erro desconhecido."),
  }, { status: Number(lastError?.status) >= 400 && Number(lastError?.status) < 600 ? Number(lastError.status) : 502 });
}
