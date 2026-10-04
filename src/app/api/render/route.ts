import { NextResponse } from "next/server";

type Scene = {
  narration?: string;
  duration?: number;
  visualUrl?: string;
  visualType?: string;
  visualPrompt?: string;
};

function dimensions(aspectRatio: string) {
  if (aspectRatio === "9:16") return { width: 1080, height: 1920 };
  if (aspectRatio === "1:1") return { width: 1080, height: 1080 };
  return { width: 1920, height: 1080 };
}

function renderScript(body: any) {
  const { width, height } = dimensions(String(body.aspectRatio || "16:9"));
  let cursor = 0;
  const elements: any[] = [];

  for (const scene of (body.scenes || []) as Scene[]) {
    const duration = Math.max(1, Number(scene.duration) || 4);
    const type = String(scene.visualType || "");

    if (scene.visualUrl) {
      elements.push({
        type: "image",
        source: scene.visualUrl,
        time: cursor,
        duration,
        fit: "cover",
      });
    } else if (type === "ai-image" && scene.visualPrompt) {
      // Creatomate can ask a connected image provider to generate the asset at render time.
      elements.push({
        type: "image",
        source: scene.visualPrompt,
        provider: process.env.CREATOMATE_IMAGE_PROVIDER || "openai",
        time: cursor,
        duration,
        fit: "cover",
      });
    } else if (type === "ai-video" && scene.visualPrompt && process.env.CREATOMATE_VIDEO_PROVIDER) {
      elements.push({
        type: "video",
        source: scene.visualPrompt,
        provider: process.env.CREATOMATE_VIDEO_PROVIDER,
        time: cursor,
        duration,
        fit: "cover",
      });
    }

    if (scene.narration && process.env.CREATOMATE_VOICE_PROVIDER) {
      elements.push({
        type: "audio",
        track: 2,
        time: cursor,
        duration,
        source: scene.narration,
        provider: process.env.CREATOMATE_VOICE_PROVIDER,
      });
    }

    if (body.subtitles && scene.narration) {
      elements.push({
        type: "text",
        track: 3,
        time: Math.max(cursor, cursor + duration - Math.min(4, duration)),
        duration: Math.min(4, duration),
        text: scene.narration,
        x: "50%",
        y: "86%",
        width: "88%",
        height: "13%",
        x_alignment: "50%",
        y_alignment: "50%",
        fill_color: "#ffffff",
        background_color: "#000000b8",
        background_x_padding: "14%",
        background_y_padding: "9%",
        background_border_radius: "3%",
        font_family: "Arial",
        font_weight: 700,
        font_size: "4.1 vmin",
      });
    }

    cursor += duration;
  }

  return {
    output_format: "mp4",
    width,
    height,
    frame_rate: Number(body.fps || 30),
    duration: cursor,
    elements,
  };
}

export async function POST(req: Request) {
  const body = await req.json();
  const key = process.env.CREATOMATE_API_KEY;

  if (!key) {
    return NextResponse.json({
      configured: false,
      provider: "Creatomate",
      error: "CREATOMATE_API_KEY não está configurada. O projeto já prepara o render, mas o MP4 cloud requer um render provider.",
    }, { status: 503 });
  }

  try {
    const response = await fetch("https://api.creatomate.com/v2/renders", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + key,
      },
      body: JSON.stringify(renderScript(body)),
    });

    const data = await response.json();
    if (!response.ok) {
      return NextResponse.json(
        { error: data?.error_message || data?.message || "Falha ao iniciar render." },
        { status: response.status }
      );
    }

    return NextResponse.json({
      configured: true,
      provider: "Creatomate",
      render: data,
    });
  } catch (error) {
    console.error("Render error:", error);
    return NextResponse.json({ error: "Erro a iniciar o render cloud." }, { status: 502 });
  }
}

export async function GET(req: Request) {
  const id = new URL(req.url).searchParams.get("id");
  const key = process.env.CREATOMATE_API_KEY;

  if (!id || !key) {
    return NextResponse.json({ error: "Render ID ou CREATOMATE_API_KEY em falta." }, { status: 400 });
  }

  const response = await fetch("https://api.creatomate.com/v2/renders/" + encodeURIComponent(id), {
    headers: { Authorization: "Bearer " + key },
    cache: "no-store",
  });

  const data = await response.json();
  return NextResponse.json(data, { status: response.status });
}
