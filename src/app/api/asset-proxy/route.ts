import { NextResponse } from "next/server";

const ALLOWED_HOSTS = new Set([
  "upload.wikimedia.org",
  "commons.wikimedia.org",
]);

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

export const runtime = "nodejs";
export const maxDuration = 30;

function errorResponse(code: string, error: string, status: number, detail?: string) {
  return NextResponse.json({ code, error, stage: "image", provider: "asset-proxy", detail }, { status });
}

export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("url") || "";
  let target: URL;

  try {
    target = new URL(raw);
  } catch {
    return errorResponse("IMAGE_PROXY_URL_INVALID", "URL de imagem inválido.", 400);
  }

  if (target.protocol !== "https:" || !ALLOWED_HOSTS.has(target.hostname)) {
    return errorResponse("IMAGE_PROXY_HOST_BLOCKED", "Fonte de imagem não permitida.", 403);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(target.toString(), {
      headers: { "User-Agent": "AI-Video-Factory/1.0 (asset proxy)" },
      cache: "no-store",
      redirect: "follow",
      signal: controller.signal,
    });

    if (!response.ok) {
      return errorResponse(
        "IMAGE_PROXY_UPSTREAM_ERROR",
        "O servidor de imagens respondeu com HTTP " + response.status + ".",
        502,
        "upstream_status=" + response.status
      );
    }

    const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!contentType.startsWith("image/")) {
      return errorResponse(
        "IMAGE_PROXY_INVALID_CONTENT_TYPE",
        "O download respondeu, mas não é uma imagem.",
        502,
        "content_type=" + (contentType || "missing")
      );
    }

    const lengthHeader = response.headers.get("content-length");
    if (lengthHeader && Number(lengthHeader) > MAX_IMAGE_BYTES) {
      return errorResponse("IMAGE_PROXY_TOO_LARGE", "A imagem excede o limite de 15 MB.", 413);
    }

    const body = await response.arrayBuffer();
    if (!body.byteLength) {
      return errorResponse("IMAGE_PROXY_EMPTY_BODY", "O servidor devolveu uma imagem vazia.", 502);
    }
    if (body.byteLength > MAX_IMAGE_BYTES) {
      return errorResponse("IMAGE_PROXY_TOO_LARGE", "A imagem excede o limite de 15 MB.", 413);
    }

    return new Response(body, {
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(body.byteLength),
        "Cache-Control": "public, max-age=3600, immutable",
        "X-Asset-Validated": "true",
      },
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const timeout = detail.toLowerCase().includes("abort");
    return errorResponse(
      timeout ? "IMAGE_PROXY_TIMEOUT" : "IMAGE_PROXY_NETWORK_ERROR",
      timeout ? "O download da imagem excedeu o tempo limite." : "Falha de rede ao descarregar o asset.",
      502,
      detail
    );
  } finally {
    clearTimeout(timer);
  }
}
