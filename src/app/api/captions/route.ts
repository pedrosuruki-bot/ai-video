import { NextResponse } from "next/server";

type Scene = { narration?: string; duration?: number };

const stamp = (seconds: number) => {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const total = Math.floor(totalMs / 1000);
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return [h, m, s].map((v) => String(v).padStart(2, "0")).join(":") + "," + String(ms).padStart(3, "0");
};

export async function POST(req: Request) {
  const body = (await req.json()) as { scenes?: Scene[]; format?: "srt" | "vtt" };
  const scenes = Array.isArray(body.scenes) ? body.scenes : [];
  const format = body.format === "vtt" ? "vtt" : "srt";

  let cursor = 0;
  const cues: string[] = [];

  scenes.forEach((scene, i) => {
    const narration = String(scene.narration || "").trim();
    if (!narration) return;
    const duration = Math.max(1, Number(scene.duration) || 4);
    const start = cursor;
    const end = cursor + duration;
    cursor = end;
    if (format === "vtt") {
      cues.push(String(i + 1) + "\n" + stamp(start).replace(",", ".") + " --> " + stamp(end).replace(",", ".") + "\n" + narration);
    } else {
      cues.push(String(i + 1) + "\n" + stamp(start) + " --> " + stamp(end) + "\n" + narration);
    }
  });

  const content = format === "vtt" ? "WEBVTT\n\n" + cues.join("\n\n") : cues.join("\n\n");
  return new Response(content, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Content-Disposition": 'attachment; filename="captions.' + format + '"',
    },
  });
}
