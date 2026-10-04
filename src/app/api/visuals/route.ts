import { NextResponse } from "next/server";
import { getOpenAI } from "@/lib/openai";

type VisualRequest = {
  prompt?: string;
  stockQuery?: string;
  mode?: "stock" | "ai";
  aspectRatio?: string;
  style?: string;
};

const IMAGE_HOSTS = new Set(["upload.wikimedia.org", "commons.wikimedia.org"]);

export const runtime = "nodejs";
export const maxDuration = 60;

function wikimediaSize(aspectRatio: string) {
  if (aspectRatio === "9:16") return "1024x1536";
  if (aspectRatio === "1:1") return "1024x1024";
  return "1536x1024";
}

function classifyProviderError(error: any) {
  const status = Number(error?.status || error?.statusCode || 0);
  const rawCode = String(error?.code || error?.error?.code || "").toLowerCase();
  const rawType = String(error?.type || error?.error?.type || "").toLowerCase();
  const message = String(error?.message || error?.error?.message || error || "Erro desconhecido.");
  const lower = message.toLowerCase();

  if (
    status === 401 ||
    status === 403 ||
    /invalid.*key|api key|authentication|unauthorized/.test(lower) ||
    /invalid_api_key/.test(rawCode)
  ) {
    return { code: "OPENAI_AUTH_ERROR", message: "A autenticação da OpenAI falhou.", retryable: false };
  }

  if (
    /credit_balance_exhausted|insufficient_quota|organization_usage_limit_exceeded|organization_spend_limit_exceeded|project_spend_limit_exceeded|billing_hard_limit_reached/.test(rawCode) ||
    /billing|credit balance|insufficient quota|usage limit|spend limit|quota exceeded/.test(lower)
  ) {
    return { code: "OPENAI_BILLING_ERROR", message: "A conta/projeto da OpenAI atingiu um limite de saldo, quota ou spend.", retryable: false };
  }

  if (status === 429 || /rate.?limit|too many requests/.test(lower) || rawType.includes("rate")) {
    return { code: "OPENAI_RATE_LIMIT", message: "A OpenAI aplicou um rate limit temporário.", retryable: true };
  }

  if (
    /model.*(not found|does not exist|unavailable|not available)|unknown model|model_not_found/.test(lower) ||
    /model_not_found/.test(rawCode)
  ) {
    return { code: "OPENAI_MODEL_UNAVAILABLE", message: "O modelo de imagens configurado não está disponível para esta API/projeto.", retryable: false };
  }

  if (status >= 500 || /timeout|timed out|network|fetch failed|temporar|overloaded|bad gateway|service unavailable/.test(lower)) {
    return { code: "IMAGE_PROVIDER_ERROR", message: "O serviço de imagens teve um erro temporário.", retryable: true };
  }

  return { code: "IMAGE_PROVIDER_ERROR", message, retryable: false };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function cleanStockQuery(input: string) {
  const stop = new Set([
    "cinematic","documentary","documentário","visual","illustrating","illustration","scene","description",
    "create","strong","composition","natural","lighting","clear","subject","visually","understandable",
    "glance","style","realistic","editorial","long","form","youtube","video","imagem","imagem","mostrar",
    "mostra","cena","filmagem","professional","slow","camera","soft","cut","the","a","an","and","with",
    "para","uma","um","de","da","do","das","dos","que","como","porque","quando","esta","este","isso",
    "sobre","em","por","na","no","nas","nos","ao","aos","e","ou","simple","clean","white","photograph",
    "photo","realism","realistic","professional","generic","illustrating","description"
  ]);

  const text = String(input || "")
    .replace(/^câmara.*?:/i, "")
    .replace(/scene description:/gi, " ")
    .replace(/[\n\r]+/g, " ")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ");

  const words = text
    .split(/\s+/)
    .map((word) => word.trim())
    .filter(Boolean)
    .filter((word) => !stop.has(word.toLowerCase()))
    .filter((word) => word.length >= 3)
    .slice(0, 10);

  return words.join(" ").trim() || text.split(/\s+/).filter(Boolean).slice(0, 8).join(" ");
}

async function searchWikimedia(query: string) {
  const cleaned = cleanStockQuery(query);
  const compactWords = cleaned.split(/\s+/).filter(Boolean);
  const rawCandidates = [
    cleaned,
    compactWords.slice(0, 3).join(" "),
    compactWords.slice(0, 2).join(" "),
    compactWords.slice(0, 1).join(" "),
    String(query || "").split(/[,:;.!?]/)[0].trim(),
  ];

  const candidates = Array.from(new Set(rawCandidates.filter((value) => value.length >= 2)));

  for (const candidate of candidates) {
    const params = new URLSearchParams({
      action: "query",
      generator: "search",
      gsrsearch: candidate,
      gsrnamespace: "6",
      gsrlimit: "8",
      prop: "imageinfo",
      iiprop: "url|mime|extmetadata|size",
      iiurlwidth: "1280",
      format: "json",
      origin: "*",
    });

    let response: Response | null = null;
    let lastError = "";

    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        response = await fetch("https://commons.wikimedia.org/w/api.php?" + params.toString(), {
          headers: { "User-Agent": "AI-Video-Factory/1.0 (visual search)" },
          cache: "no-store",
          signal: controller.signal,
        });
        if (response.ok) break;
        lastError = "HTTP " + response.status;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      } finally {
        clearTimeout(timer);
      }
      if (attempt === 0) await sleep(500);
    }

    if (!response || !response.ok) {
      throw new Error("Wikimedia Commons não respondeu (" + (lastError || "erro desconhecido") + ").");
    }

    const data = await response.json();
    const pages = Object.values((data?.query?.pages || {}) as Record<string, any>);

    const results = pages
      .filter((page: any) => {
        const info = page.imageinfo?.[0];
        return Boolean(info?.url) && /^image\//i.test(String(info?.mime || ""));
      })
      .map((page: any) => {
        const info = page.imageinfo[0];
        const meta = info.extmetadata || {};
        return {
          title: String(page.title || "").replace(/^File:/, ""),
          imageUrl: String(info.thumburl || info.url),
          mime: String(info.mime || ""),
          size: Number(info.size || 0),
          pageUrl: String(info.descriptionurl || ("https://commons.wikimedia.org/wiki/" + encodeURIComponent(page.title))),
          license: String(meta.LicenseShortName?.value || meta.License?.value || "Wikimedia Commons"),
          artist: meta.Artist?.value ? String(meta.Artist.value).replace(/<[^>]+>/g, "") : "",
        };
      })
      .filter((item) => {
        try {
          const host = new URL(item.imageUrl).hostname;
          const mime = item.mime.toLowerCase();
          return IMAGE_HOSTS.has(host) &&
            item.imageUrl.startsWith("https://") &&
            item.size > 0 &&
            item.size <= 15 * 1024 * 1024 &&
            ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(mime);
        } catch {
          return false;
        }
      });

    if (results.length) return results;
  }

  return [];
}

function responseError(code: string, message: string, status: number, extra: Record<string, unknown> = {}) {
  return NextResponse.json({
    error: message,
    code,
    stage: "image",
    ...extra,
  }, { status });
}

export async function POST(req: Request) {
  let body: VisualRequest;

  try {
    body = (await req.json()) as VisualRequest;
  } catch {
    return responseError("IMAGE_INPUT_ERROR", "Pedido visual inválido.", 400);
  }

  const prompt = String(body.prompt || "").trim();
  const mode = body.mode || "stock";

  if (prompt.length < 3) {
    return responseError("IMAGE_INPUT_ERROR", "Prompt visual em falta.", 400);
  }

  if (mode === "stock") {
    try {
      const query = cleanStockQuery(body.stockQuery || prompt);
      const results = await searchWikimedia(query);

      if (!results.length) {
        return responseError(
          "WIKIMEDIA_NO_RESULTS",
          "Não encontrei um visual utilizável no Wikimedia Commons.",
          404,
          { provider: "Wikimedia Commons", query }
        );
      }

      return NextResponse.json({
        mode: "stock",
        source: "Wikimedia Commons",
        query,
        results,
        selected: results[0],
      });
    } catch (error) {
      console.error("Visual stock error", {
        code: "WIKIMEDIA_SEARCH_ERROR",
        message: error instanceof Error ? error.message : String(error),
      });
      return responseError(
        "WIKIMEDIA_SEARCH_ERROR",
        "Falha ao procurar imagens no Wikimedia Commons.",
        502,
        {
          provider: "Wikimedia Commons",
          query: cleanStockQuery(body.stockQuery || prompt),
          detail: error instanceof Error ? error.message : String(error),
        }
      );
    }
  }

  const imageModel = process.env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-flare";
  const fallbackQuery = cleanStockQuery(body.stockQuery || prompt);
  const ai = getOpenAI();
  let lastProviderError: any = null;

  if (!ai) {
    lastProviderError = Object.assign(new Error("OPENAI_API_KEY em falta."), { code: "invalid_api_key", status: 401 });
  } else {
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
        if (!b64 || typeof b64 !== "string") {
          throw Object.assign(new Error("A API não devolveu b64_json para a imagem."), { code: "IMAGE_RESPONSE_EMPTY" });
        }

        return NextResponse.json({
          mode: "ai",
          source: "OpenAI",
          imageUrl: "data:image/jpeg;base64," + b64,
          model: imageModel,
        });
      } catch (error) {
        lastProviderError = error;
        const classified = classifyProviderError(error);
        console.error("OpenAI image error", {
          code: classified.code,
          message: classified.message,
          status: Number((error as any)?.status || 0),
          model: imageModel,
        });

        if (!classified.retryable || attempt === 1) break;
        await sleep(700 * (attempt + 1));
      }
    }
  }

  const classified = classifyProviderError(lastProviderError);

  if (!classified.retryable && classified.code === "OPENAI_MODEL_UNAVAILABLE") {
    console.error("OpenAI image model unavailable", {
      code: classified.code,
      model: imageModel,
    });
  }

  try {
    const results = await searchWikimedia(fallbackQuery);
    if (results.length) {
      return NextResponse.json({
        mode: "stock",
        source: "Wikimedia Commons (fallback)",
        warning: "A imagem IA falhou; foi usada uma imagem de stock/licenciada como fallback.",
        originalProviderError: {
          code: classified.code,
          message: classified.message,
        },
        fallbackProvider: "Wikimedia Commons",
        fallbackQuery,
        results,
        selected: results[0],
      });
    }
  } catch (fallbackError) {
    console.error("Wikimedia fallback error", {
      code: "WIKIMEDIA_SEARCH_ERROR",
      message: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      originalProviderError: classified.code,
    });

    return responseError(
      "WIKIMEDIA_SEARCH_ERROR",
      "A imagem IA falhou e o fallback Wikimedia também falhou.",
      502,
      {
        provider: "Wikimedia Commons",
        originalProviderError: {
          code: classified.code,
          message: classified.message,
        },
        fallbackProvider: "Wikimedia Commons",
        fallbackQuery,
        detail: fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      }
    );
  }

  return responseError(
    classified.code,
    "A imagem IA falhou e não foi encontrado fallback no Wikimedia Commons.",
    502,
    {
      provider: "OpenAI",
      originalProviderError: {
        code: classified.code,
        message: classified.message,
      },
      fallbackProvider: "Wikimedia Commons",
      fallbackQuery,
    }
  );
}
