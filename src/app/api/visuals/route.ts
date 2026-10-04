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

    const res = await fetch("https://commons.wikimedia.org/w/api.php?" + params.toString(), {
      headers: { "User-Agent": "AI-Video-Factory/1.0 (visual search)" },
      cache: "no-store",
    });

    if (!res.ok) throw new Error("Wikimedia Commons não respondeu.");
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
        return NextResponse.json({ error: "Não encontrei um visual para esta pesquisa." }, { status: 404 });
      }
      return NextResponse.json({
        mode: "stock",
        source: "Wikimedia Commons",
        results,
        selected: results[0],
      });
    } catch (error) {
      console.error("Visual stock error:", error);
      return NextResponse.json({ error: "Falha ao procurar imagens no Wikimedia Commons." }, { status: 502 });
    }
  }

  const ai = getOpenAI();
  if (!ai) {
    return NextResponse.json({ error: "Configure OPENAI_API_KEY para gerar imagens com IA." }, { status: 503 });
  }

  try {
    const image = await (ai.images.generate as any)({
      model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-flare",
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
      model: process.env.OPENAI_IMAGE_MODEL || "gpt-image-2.5-flare",
    });
  } catch (error) {
    console.error("OpenAI image error:", error);
    return NextResponse.json({ error: "A geração de imagem com IA falhou." }, { status: 502 });
  }
}
