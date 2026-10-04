import { NextResponse } from "next/server";
import { getOpenAI } from "@/lib/openai";

export const runtime = "nodejs";
export const maxDuration = 60;

function classifyTtsError(error: any) {
  const status = Number(error?.status || error?.statusCode || 0);
  const rawCode = String(error?.code || error?.error?.code || "").toLowerCase();
  const message = String(error?.message || error?.error?.message || error || "Erro desconhecido.");
  const lower = message.toLowerCase();

  if (
    status === 401 ||
    status === 403 ||
    /invalid.*key|api key|authentication|unauthorized/.test(lower) ||
    /invalid_api_key/.test(rawCode)
  ) {
    return { code: "TTS_AUTH_ERROR", message: "A autenticação da OpenAI falhou para TTS.", retryable: false };
  }

  if (
    /credit_balance_exhausted|insufficient_quota|organization_usage_limit_exceeded|organization_spend_limit_exceeded|project_spend_limit_exceeded|billing_hard_limit_reached/.test(rawCode) ||
    /billing|credit balance|insufficient quota|usage limit|spend limit|quota exceeded/.test(lower)
  ) {
    return { code: "TTS_BILLING_ERROR", message: "A conta/projeto da OpenAI atingiu um limite de saldo, quota ou spend.", retryable: false };
  }

  if (status === 429 || /rate.?limit|too many requests/.test(lower)) {
    return { code: "TTS_RATE_LIMIT", message: "A OpenAI aplicou um rate limit temporário para TTS.", retryable: true };
  }

  if (/model.*(not found|does not exist|unavailable|not available)|unknown model|model_not_found/.test(lower) || /model_not_found/.test(rawCode)) {
    return { code: "TTS_MODEL_UNAVAILABLE", message: "O modelo TTS configurado não está disponível para esta API/projeto.", retryable: false };
  }

  if (/voice.*(not found|invalid|unavailable)|voice_not_found/.test(lower) || /voice_not_found/.test(rawCode)) {
    return { code: "TTS_VOICE_UNAVAILABLE", message: "A voz configurada não está disponível para o modelo TTS.", retryable: false };
  }

  if (status >= 500 || /timeout|timed out|network|fetch failed|temporar|overloaded|bad gateway|service unavailable/.test(lower)) {
    return { code: "TTS_PROVIDER_ERROR", message: "O serviço de voz teve um erro temporário.", retryable: true };
  }

  return { code: "TTS_PROVIDER_ERROR", message, retryable: false };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function POST(req: Request) {
  let body: { text?: string; voice?: string; speed?: number };

  try {
    body = (await req.json()) as { text?: string; voice?: string; speed?: number };
  } catch {
    return NextResponse.json({
      error: "Pedido TTS inválido.",
      code: "TTS_INPUT_ERROR",
      stage: "audio",
    }, { status: 400 });
  }

  const text = String(body.text || "").trim();

  if (!text) {
    return NextResponse.json({
      error: "Texto em falta.",
      code: "TTS_INPUT_ERROR",
      stage: "audio",
    }, { status: 400 });
  }

  if (text.length > 4096) {
    return NextResponse.json({
      error: "Esta cena é demasiado longa para uma única geração de voz. Divida a narração em cenas menores.",
      code: "TTS_INPUT_TOO_LONG",
      stage: "audio",
    }, { status: 400 });
  }

  const model = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
  const voice = body.voice || process.env.OPENAI_TTS_VOICE || "marin";
  const ai = getOpenAI();

  if (!ai) {
    return NextResponse.json({
      error: "OPENAI_API_KEY em falta.",
      code: "TTS_AUTH_ERROR",
      stage: "audio",
      provider: "OpenAI",
    }, { status: 503 });
  }

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

      const contentType = String(audio.headers?.get?.("content-type") || "audio/mpeg").split(";")[0].toLowerCase();
      if (contentType !== "audio/mpeg" && contentType !== "audio/mp3") {
        throw Object.assign(new Error("A resposta TTS devolveu Content-Type inesperado: " + contentType), { code: "AUDIO_RESPONSE_INVALID" });
      }

      const buffer = await audio.arrayBuffer();
      if (!buffer.byteLength) {
        throw Object.assign(new Error("A API devolveu um áudio vazio."), { code: "AUDIO_RESPONSE_INVALID" });
      }

      return new Response(buffer, {
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Length": String(buffer.byteLength),
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
      await sleep(700 * (attempt + 1));
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
  }, {
    status: Number(lastError?.status) >= 400 && Number(lastError?.status) < 600
      ? Number(lastError.status)
      : 502,
  });
}
