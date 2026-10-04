import type { Settings, Scene } from "./types";

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

const sec = (s: string) =>
  Math.max(3, Math.round(words(s) / 2.5));

export function fallback(script: string, settings: Settings) {
  const parts = script
    .replace(/\r/g, "")
    .split(/(?<=[.!?])\s+/)
    .map((x) => x.trim())
    .filter(Boolean);

  const groups: string[][] = [];
  for (let i = 0; i < parts.length; i += 2) {
    groups.push(parts.slice(i, i + 2));
  }

  if (!groups.length && script.trim()) groups.push([script.trim()]);

  const scenes: Scene[] = groups.map((g, i) => {
    const narration = g.join(" ");
    return {
      id: "scene-" + (i + 1),
      index: i + 1,
      narration,
      duration: sec(narration),
      visualType: i % 2 ? "ai-image" : "stock",
      visualPrompt: "Cinematic documentary visual illustrating: " + narration,
      searchQueries: narration
        .split(/[,:;]/)
        .map((x) => x.trim())
        .filter(Boolean)
        .slice(0, 2),
      camera: "Slow cinematic push-in",
      transition: "Soft cut",
    };
  });

  return {
    title: "Novo vídeo",
    summary: "Storyboard criado em modo local para " + settings.language,
    wordCount: words(script),
    estimatedDuration: Math.round((words(script) / 150) * 60),
    scenes,
    mode: "fallback",
  };
}
