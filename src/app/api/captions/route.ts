import { NextResponse } from "next/server";

type Scene = { id?: string; narration?: string; duration?: number };

export const runtime = "nodejs";
export const maxDuration = 30;

const stamp = (seconds: number, vtt = false) => {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const total = Math.floor(totalMs / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":") +
    (vtt ? "." : ",") + String(ms).padStart(3, "0");
};

export async function POST(req: Request) {
  let body: { scenes?: Scene[]; format?: "srt" | "vtt" };
  try {
    body = (await req.json()) as { scenes?: Scene[]; format?: "srt" | "vtt" };
  } catch {
    return NextResponse.json({
      error: "JSON inválido.",
      code: "CAPTION_INPUT_ERROR",
      stage: "captions",
    }, { status: 400 });
  }

  const scenes = Array.isArray(body.scenes) ? body.scenes : [];
  const format = body.format === "vtt" ? "vtt" : "srt";

  if (!scenes.length) {
    return NextResponse.json({
      error: "Nenhuma cena disponível para gerar legendas.",
      code: "CAPTION_INPUT_ERROR",
      stage: "captions",
    }, { status: 400 });
  }

  const invalid = scenes
    .map((scene, i) => {
      const label = "Cena " + String(i + 1).padStart(3, "0");
      if (!String(scene.narration || "").trim()) return label + ": narração em falta.";
      if (!(Number(scene.duration) > 0)) return label + ": duração inválida.";
      return "";
    })
    .filter(Boolean);

  if (invalid.length) {
    return NextResponse.json({
      error: "Não foi possível gerar legendas porque existem cenas inválidas.",
      code: "CAPTION_INPUT_ERROR",
      stage: "captions",
      details: invalid,
    }, { status: 400 });
  }

  let cursor = 0;
  const cues: string[] = scenes.map((scene, i) => {
    const narration = String(scene.narration).trim();
    const duration = Number(scene.duration);
    const start = cursor;
    const end = cursor + duration;
    cursor = end;

    if (format === "vtt") {
      return String(i + 1) + "\n" +
        stamp(start, true) + " --> " + stamp(end, true) + "\n" + narration;
    }
    return String(i + 1) + "\n" +
      stamp(start) + " --> " + stamp(end) + "\n" + narration;
  });

  const content = format === "vtt"
    ? "WEBVTT\n\n" + cues.join("\n\n")
    : cues.join("\n\n");

  return new Response(content, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": 'attachment; filename="captions.' + format + '"',
      "Cache-Control": "no-store",
    },
  });
}
