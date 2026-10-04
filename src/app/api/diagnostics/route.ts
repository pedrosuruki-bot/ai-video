import { NextResponse } from "next/server";
import { getOpenAI } from "@/lib/openai";

export const runtime = "nodejs";
export const maxDuration = 30;

function classifyDiagnosticError(error: any, stage: "openai" | "image" | "tts" | "stock") {
  const status = Number(error?.status || error?.statusCode || 0);
  const code = String(error?.code || error?.error?.code || "").toLowerCase();
  const message = String(error?.message || error?.error?.message || error || "");
  const lower = message.toLowerCase();

  if (stage === "stock") {
    return { code: "STOCK_PROVIDER_ERROR", message: "Wikimedia Commons está indisponível.", retryable: true };
  }
  if (status === 401 || status === 403 || /invalid.*key|api key|authentication|unauthorized/.test(lower) || code === "invalid_api_key") {
    return { code: "OPENAI_AUTH_ERROR", message: "A autenticação da OpenAI falhou.", retryable: false };
  }
  if (/credit_balance_exhausted|insufficient_quota|organization_usage_limit_exceeded|organization_spend_limit_exceeded|project_spend_limit_exceeded|billing_hard_limit_reached/.test(code) ||
      /billing|credit balance|insufficient quota|usage limit|spend limit|quota exceeded/.test(lower)) {
    return { code: "OPENAI_BILLING_ERROR", message: "A conta/projeto da OpenAI atingiu um limite de saldo, quota ou spend.", retryable: false };
  }
  if (status === 429 || /rate.?limit|too many requests/.test(lower)) {
    return { code: "OPENAI_RATE_LIMIT", message: "A OpenAI está a aplicar rate limit.", retryable: true };
  }
  if (/model.*(not found|does not exist|unavailable|not available)|unknown model|model_not_found/.test(lower) || code === "model_not_found") {
    return { code: stage === "image" ? "OPENAI_MODEL_UNAVAILABLE" : "TTS_MODEL_UNAVAILABLE", message: "O modelo configurado não está disponível.", retryable: false };
  }
  if (status >= 500 || /timeout|timed out|network|fetch failed|temporar|overloaded|bad gateway|service unavailable/.test(lower)) {
    return { code: "OPENAI_UNREACHABLE", message: "A OpenAI não respondeu de forma utilizável.", retryable: true };
  }
  return { code: "OPENAI_PROVIDER_ERROR", message: "O provider da OpenAI respondeu com erro.", retryable: false };
}

async function checkModel(ai: any, model: string, stage: "image" | "tts") {
  try {
    await ai.models.retrieve(model);
    return {
      configured: true,
      reachable: true,
      available: true,
      model,
    };
  } catch (error) {
    const err = error as any;
    const classified = classifyDiagnosticError(err, stage);
    console.error("Provider diagnostics error", {
      stage,
      code: classified.code,
      status: Number(err?.status || 0),
      model,
    });
    return {
      configured: true,
      reachable: classified.code === "OPENAI_PROVIDER_ERROR" || classified.code === "OPENAI_BILLING_ERROR" || classified.code === "OPENAI_RATE_LIMIT",
      available: false,
      model,
      error: classified,
    };
  }
}

async function checkStock() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
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

    if (!response.ok) {
      throw new Error("HTTP " + response.status);
    }

    const data = await response.json();
    const pages = Object.values((data?.query?.pages || {}) as Record<string, any>);
    const valid = pages.some((page: any) => /^image\//i.test(String(page?.imageinfo?.[0]?.mime || "")) && page?.imageinfo?.[0]?.url);

    if (!valid) {
      throw new Error("A API respondeu sem uma imagem utilizável.");
    }

    return { configured: true, reachable: true, available: true };
  } catch (error) {
    const classified = classifyDiagnosticError(error, "stock");
    return {
      configured: true,
      reachable: false,
      available: false,
      error: classified,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function GET() {
  const openaiConfigured = Boolean(process.env.OPENAI_API_KEY);
  const imageModel = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-flare";
  const ttsModel = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
  const ttsVoice = process.env.OPENAI_TTS_VOICE || "marin";

  const stock = await checkStock();

  if (!openaiConfigured) {
    return NextResponse.json({
      status: "degraded",
      openai: {
        configured: false,
        reachable: false,
        error: { code: "OPENAI_AUTH_ERROR", message: "OPENAI_API_KEY em falta." },
      },
      image: { configured: false, reachable: false, available: false, model: imageModel, error: { code: "ENVIRONMENT_ERROR", message: "OPENAI_API_KEY em falta." } },
      tts: { configured: false, reachable: false, available: false, model: ttsModel, voice: ttsVoice, error: { code: "ENVIRONMENT_ERROR", message: "OPENAI_API_KEY em falta." } },
      stock,
      timestamp: new Date().toISOString(),
    });
  }

  const ai = getOpenAI();
  const [image, tts] = await Promise.all([
    checkModel(ai, imageModel, "image"),
    checkModel(ai, ttsModel, "tts"),
  ]);

  const openaiReachable = Boolean(image.reachable || tts.reachable);
  return NextResponse.json({
    status: image.available && tts.available && stock.available ? "ready" : "degraded",
    openai: {
      configured: true,
      reachable: openaiReachable,
    },
    image,
    tts: {
      ...tts,
      voice: ttsVoice,
    },
    stock,
    timestamp: new Date().toISOString(),
  });
}
