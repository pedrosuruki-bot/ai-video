export type SceneLike = {
  id?: string;
  index?: number;
  narration?: string;
  duration?: number;
  visualType?: string;
  visualPrompt?: string;
  searchQueries?: string[];
  camera?: string;
  transition?: string;
};

type CaptionFormat = "srt" | "vtt";

function parseTimestamp(value: string): number | null {
  const match = value.trim().match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) return null;
  const [, hh, mm, ss, ms] = match;
  const h = Number(hh);
  const m = Number(mm);
  const s = Number(ss);
  const milli = Number(ms);
  if (m > 59 || s > 59) return null;
  return h * 3600 + m * 60 + s + milli / 1000;
}

export function validateStoryboard(scenes: SceneLike[]): string[] {
  const errors: string[] = [];
  if (!Array.isArray(scenes) || scenes.length === 0) {
    return ["O storyboard não contém cenas."];
  }

  const ids = new Set<string>();
  scenes.forEach((scene, i) => {
    const label = "Cena " + String(i + 1).padStart(3, "0");
    if (!scene.id?.trim()) errors.push(label + ": id em falta.");
    if (scene.id && ids.has(scene.id)) errors.push(label + ": id duplicado.");
    if (scene.id) ids.add(scene.id);
    if (Number(scene.index) !== i + 1) errors.push(label + ": index inválido.");
    if (!scene.narration?.trim()) errors.push(label + ": narração em falta.");
    if (!(Number(scene.duration) > 0)) errors.push(label + ": duração inválida.");
    const visualType = String(scene.visualType || "");
    if (!["stock", "ai-image", "ai-video", "graphic", "text"].includes(visualType)) {
      errors.push(label + ": visualType inválido.");
    }
    if (!scene.visualPrompt?.trim() && !(scene.searchQueries || []).some((q) => String(q).trim())) {
      errors.push(label + ": prompt/query visual em falta.");
    }
    if ((scene.searchQueries || []).some((q) => !String(q).trim())) {
      errors.push(label + ": searchQueries contém entradas vazias.");
    }
    if (!scene.camera?.trim()) errors.push(label + ": câmera em falta.");
    if (!scene.transition?.trim()) errors.push(label + ": transição em falta.");
  });

  return errors;
}

export function validateCaptionText(text: string, format: CaptionFormat, expectedCues: number): string[] {
  const errors: string[] = [];
  if (!text.trim()) return ["Legenda " + format.toUpperCase() + " vazia."];

  const body = format === "vtt"
    ? text.replace(/^WEBVTT\s*/i, "").trim()
    : text.trim();

  const cueBlocks = body.split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  let cues = cueBlocks;

  if (format === "vtt") {
    cues = cueBlocks.filter((b) => /\d{2}:\d{2}:\d{2}\.\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}\.\d{3}/.test(b));
  }

  if (cues.length !== expectedCues) {
    errors.push("Legenda " + format.toUpperCase() + " incompleta: " + cues.length + "/" + expectedCues + " cues.");
  }

  let previousEnd = -1;
  cues.forEach((cue, i) => {
    const lines = cue.split(/\r?\n/);
    const timestampIndex = lines.findIndex((line) => line.includes("-->"));
    if (timestampIndex < 0) {
      errors.push("Legenda " + format.toUpperCase() + ": cue " + (i + 1) + " sem timestamp.");
      return;
    }

    const timestamp = lines[timestampIndex].split("-->");
    if (timestamp.length !== 2) {
      errors.push("Legenda " + format.toUpperCase() + ": cue " + (i + 1) + " com timestamp inválido.");
      return;
    }

    const startRaw = timestamp[0].trim().split(/\s+/)[0];
    const endRaw = timestamp[1].trim().split(/\s+/)[0];
    const start = parseTimestamp(startRaw);
    const end = parseTimestamp(endRaw);
    if (start === null || end === null || !(end > start)) {
      errors.push("Legenda " + format.toUpperCase() + ": cue " + (i + 1) + " tem intervalo temporal inválido.");
    } else {
      if (start < previousEnd) {
        errors.push("Legenda " + format.toUpperCase() + ": cue " + (i + 1) + " sobrepõe a cue anterior.");
      }
      previousEnd = end;
    }

    const payload = lines.slice(timestampIndex + 1).join(" ").trim();
    if (!payload) {
      errors.push("Legenda " + format.toUpperCase() + ": cue " + (i + 1) + " sem texto.");
    }
  });

  if (format === "vtt" && !/^WEBVTT(?:\s|$)/i.test(text.trim())) {
    errors.push("VTT sem cabeçalho WEBVTT.");
  }

  return errors;
}

export function validateTimeline(
  timeline: Array<{ scene: number; start: number; end: number; duration: number; image: string; audio: string }>,
  expectedScenes: number
): string[] {
  const errors: string[] = [];
  if (timeline.length !== expectedScenes) {
    errors.push("Timeline incompleta: " + timeline.length + "/" + expectedScenes + " cenas.");
  }

  let previousEnd = 0;
  timeline.forEach((item, i) => {
    const label = "Timeline cena " + String(i + 1).padStart(3, "0");
    if (item.scene !== i + 1) errors.push(label + ": número de cena inválido.");
    if (!(item.end > item.start) || !(item.duration > 0)) errors.push(label + ": duração/intervalo inválido.");
    if (i > 0 && item.start !== previousEnd) errors.push(label + ": início não coincide com o fim anterior.");
    if (!item.image?.trim()) errors.push(label + ": referência de imagem em falta.");
    if (!item.audio?.trim()) errors.push(label + ": referência de áudio em falta.");
    previousEnd = item.end;
  });

  return errors;
}

export function isImageBytes(bytes: Uint8Array, contentType = ""): boolean {
  const type = contentType.toLowerCase().split(";")[0].trim();
  if (!type.startsWith("image/")) return false;
  if (bytes.length < 12) return false;

  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.slice(0, 8).every((v, i) => v === [0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a][i]);
  const webp = bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50;
  const gif = bytes.slice(0, 6).every((v, i) => v === Array.from("GIF89a").map((c) => c.charCodeAt(0))[i] ||
    v === Array.from("GIF87a").map((c) => c.charCodeAt(0))[i]);
  return jpeg || png || webp || gif;
}

export function isMp3Bytes(bytes: Uint8Array, contentType = ""): boolean {
  const type = contentType.toLowerCase().split(";")[0].trim();
  if (type !== "audio/mpeg" && type !== "audio/mp3") return false;
  if (bytes.length < 4) return false;
  const id3 = bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33;
  const frame = bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  return id3 || frame;
}
