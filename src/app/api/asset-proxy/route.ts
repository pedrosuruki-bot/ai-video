import { NextResponse } from "next/server";

const ALLOWED_HOSTS = new Set([
  "upload.wikimedia.org",
  "commons.wikimedia.org",
]);

export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get("url") || "";
  let target: URL;

  try {
    target = new URL(raw);
  } catch {
    return NextResponse.json({ error: "URL inválido." }, { status: 400 });
  }

  if (target.protocol !== "https:" || !ALLOWED_HOSTS.has(target.hostname)) {
    return NextResponse.json({ error: "Fonte de imagem não permitida." }, { status: 403 });
  }

  try {
    const response = await fetch(target.toString(), {
      headers: { "User-Agent": "AI-Video-Factory/1.0" },
      cache: "no-store",
    });

    if (!response.ok) {
      return NextResponse.json({ error: "Não foi possível obter o asset." }, { status: response.status });
    }

    const contentType = response.headers.get("content-type") || "image/jpeg";
    return new Response(await response.arrayBuffer(), {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=3600",
      },
    });
  } catch {
    return NextResponse.json({ error: "Falha ao descarregar o asset." }, { status: 502 });
  }
}
