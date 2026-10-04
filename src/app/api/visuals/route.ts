import { NextResponse } from "next/server";
import { getOpenAI } from "@/lib/openai";

type VisualRequest = {
  prompt?: string;
  mode?: "stock" | "ai";
  aspectRatio?: string;
  style?: string;
};

function wikimediaSize(aspectRatio: string) {
  if (aspectRatio === "9:16") return "1024x1536";
  if (aspectRatio === "1:1") return "1024x1024";
  return "1536x1024";
}

function classifyProviderError(error: any) {
  const status = Number(error?.status || error?.statusCode || 0);
  const message = String(error?.message || error || "Erro desconhecido.");
  const lower = message.toLowerCase();
  if (status === 401 || status === 403 || /invalid.*key|api key|authentication|unauthorized/.test(lower)) {
    return { code: "OPENAI_AUTH_ERROR", message: "A autenticação da OpenAI falhou.", retryable: false };
  }
  if (status === 429 || /rate limit|quota|billing|credit|insufficient|spend limit/.test(lower)) {
    return { code: /billing|credit|quota|spend/.test(lower) ? "OPENAI_BILLING_ERROR" : "OPENAI_RATE_LIMIT", message: status === 429 ? "A OpenAI recusou o pedido por limite, quota ou billing." : message, retryable: status === 429 };
  }
  if (/model.*(not found|does not exist|unavailable)|unknown model/.test(lower)) {
    return { code: "OPENAI_MODEL_UNAVAILABLE", message: "O modelo de imagens configurado não está disponível para esta API.", retryable: false };
  }
  if (status >= 500 || /timeout|timed out|network|fetch failed|temporar/.test(lower)) {
    return { code: "IMAGE_PROVIDER_ERROR", message: "O serviço de imagens teve um erro temporário.", retryable: true };
  }
  return { code: "IMAGE_PROVIDER_ERROR", message: message, retryable: false };
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function searchWikimedia(query: string) {
  const candidates = Array.from(new Set([
    query.trim(),
    query.trim().split(/[,;:.!?]/)[0].split(/\s+/).slice(0, 6).join(" "),
  ].filter((x) => x.length >= 3)));

  for (const candidate of candidates) {
    const params = new URLSearchParams({
      action: "query",
      generator: "search",
      gsrsearch: candidate,
      gsrnamespace: "6",
      gsrlimit: "5",
      prop: "imageinfo",
      iiprop: "url|mime|extmetadata|size",
      iiurlwidth: "1280",
      format: "json",
      origin: "*",
    });

    let res: Response | null = null;
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 10000);
        res = await fetch("https://commons.wikimedia.org/w/api.php?" + params.toString(), {
          headers: { "User-Agent": "AI-Video-Factory/1.0 (visual search)" },
          cache: "no-store",
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (res.ok) break;
        lastError = "HTTP " + res.status;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
      if (attempt === 0) await sleep(500);
    }

    if (!res || !res.ok) {
      throw new Error("Wikimedia Commons não respondeu (" + lastError + ").");
    }
    const data = await res.json();
    const pages = Object.values((data?.query?.pages || {}) as Record<string, any>);
    const results = pages
      .filter((p: any) => p.imageinfo?.[0]?.url && /^image\//.test(p.imageinfo[0].mime || ""))
      .map((p: any) => {
        const info = p.imageinfo[0];
        const meta = info.extmetadata || {};
        return {
          title: String(p.title || "").replace(/^File:/, ""),
          imageUrl: info.thumburl || info.url,
          pageUrl: info.descriptionurl || ("https://commons.wikimedia.org/wiki/" + encodeURIComponent(p.title)),
          license: meta.LicenseShortName?.value || meta.License?.value || "Wikimedia Commons",
          artist: meta.Artist?.value ? String(meta.Artist.value).replace(/<[^>]+>/g, "") : "",
        };
      });
    if (results.length) return results;
  }
  return [];
}

export async function POST(req: Request) {
  const body = (await req.json()) as VisualRequest;
  const prompt = String(body.prompt || "").trim();
  const mode = body.mode || "stock";

  if (prompt.length < 3) {
    return NextResponse.json({ error: "Prompt visual em falta." }, { status: 400 });
  }

  if (mode === "stock") {
    try {
      const results = await searchWikimedia(prompt);
      if (!results.length) {
        return NextResponse.json({
          error: "Não encontrei um visual para esta pesquisa.",
          code: "WIKIMEDIA_NO_RESULTS",
          stage: "image",
          provider: "Wikimedia Commons",
          query: prompt,
        }, { status: 404 });
      }
      return NextResponse.json({
        mode: "stock",
        source: "Wikimedia Commons",
        results,
        selected: results[0],
      });
    } catch (error) {
      console.error("Visual stock error:", error);
      return NextResponse.json({
        error: "Falha ao procurar imagens no Wikimedia Commons.",
        code: "WIKIMEDIA_SEARCH_ERROR",
        stage: "image",
        provider: "Wikimedia Commons",
        detail: error instanceof Error ? error.message : String(error),
        query: prompt,
      }, { status: 502 });
    }
  }

  const ai = getOpenAI();
  if (!ai) {
    return NextResponse.json({
      error: "Configure OPENAI_API_KEY para gerar imagens com IA.",
      code: "OPENAI_AUTH_ERROR",
      stage: "image",
    }, { status: 503 });
  }

  const imageModel = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-flare";
  let lastError: any = null;
  const fallbackQuery = prompt
    .split(/[,;:.!?]/)[0]
    .split(/\s+/)
    .slice(0, 6)
    .join(" ");

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const image = await (ai.images.generate as any)({
      model: imageModel,
      prompt:
        "Create a cinematic, realistic editorial visual for a long-form YouTube documentary. " +
        "No text, no logos, no watermark, no collage, no split screen. " +
        "Strong composition, natural lighting, clear subject, visually understandable at a glance. " +
        "Style: " + String(body.style || "Documentário") + ". Scene description: " + prompt,
      size: wikimediaSize(String(body.aspectRatio || "16:9")),
      quality: "low",
      output_format: "jpeg",
      output_compression: 65,
    });

      const b64 = image?.data?.[0]?.b64_json;
      if (!b64) throw new Error("A API não devolveu imagem.");

      return NextResponse.json({
        mode: "ai",
        source: "OpenAI",
        imageUrl: "data:image/jpeg;base64," + b64,
        model: imageModel,
      });
    } catch (error) {
      lastError = error;
      const classified = classifyProviderError(error);
      console.error("OpenAI image error", {
        code: classified.code,
        message: classified.message,
        status: Number((error as any)?.status || 0),
        model: imageModel,
      });
      if (!classified.retryable || attempt === 1) break;
      await sleep(700);
    }
  }

    // AI image generation can fail because of temporary provider limits,
    // billing/quota, or model availability. For a usable CapCut export,
    // fall back to a licensed Wikimedia Commons result instead of returning
    // an empty asset.
    try {
      const results = await searchWikimedia(fallbackQuery);
      if (results.length) {
        const classified = classifyProviderError(lastError);
        return NextResponse.json({
          mode: "stock",
          source: "Wikimedia Commons (fallback)",
          warning: "A imagem IA falhou; foi usada uma imagem de stock/licenciada como fallback.",
          originalProviderError: {
            code: classified.code,
            message: classified.message,
          },
          fallbackProvider: "Wikimedia Commons",
          fallbackQuery: fallbackQuery,
          results,
          selected: results[0],
        });
      }
    } catch (fallbackError) {
      console.error("Wikimedia fallback error", fallbackError);
      const classified = classifyProviderError(lastError);
      return NextResponse.json({
        error: "A imagem IA falhou e o fallback Wikimedia também falhou.",
        code: "WIKIMEDIA_SEARCH_ERROR",
        stage: "image",
        provider: "Wikimedia Commons",
        originalProviderError: {
          code: classified.code,
          message: classified.message,
        },
        detail: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      }, { status: 502 });
    }

    const classified = classifyProviderError(lastError);
    return NextResponse.json({
      error: "A imagem IA falhou e não foi encontrado fallback no Wikimedia Commons.",
      code: classified.code,
      stage: "image",
      provider: "OpenAI",
      originalProviderError: {
        code: classified.code,
        message: classified.message,
      },
      fallbackProvider: "Wikimedia Commons",
      fallbackQuery: fallbackQuery,
    }, { status: 502 });
  }
