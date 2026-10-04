"use client";

import { useEffect, useMemo, useState } from "react";
import JSZip from "jszip";
import type { Analysis, AssetError, Scene, Settings } from "@/lib/types";
import { isImageBytes, isMp3Bytes, validateCaptionText, validateStoryboard, validateTimeline } from "@/lib/export-validation";
import { readValidAudioResponse } from "@/lib/media-http";

const demo =
  "Há uma razão pela qual algumas coisas que vemos todos os dias parecem completamente normais. " +
  "Mas quando paramos para olhar com atenção, percebemos que existe muito mais por trás delas. " +
  "Hoje vamos descobrir como este fenómeno funciona, porque acontece e o que muda quando as condições certas aparecem.";

const defaults: Settings = {
  language: "Português (Portugal)",
  voice: "marin",
  visualMode: "hybrid",
  aspectRatio: "16:9",
  resolution: "1080p",
  style: "Documentário",
  subtitles: true,
};

const fmt = (s: number) =>
  Math.floor(s / 60) + ":" + String(Math.round(s % 60)).padStart(2, "0");

function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export default function Home() {
  const [script, setScript] = useState("");
  const [settings, setSettings] = useState(defaults);
  const [data, setData] = useState<Analysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [packageBusy, setPackageBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [visuals, setVisuals] = useState<Record<string, string>>({});
  const [visualMeta, setVisualMeta] = useState<Record<string, string>>({});
  const [voices, setVoices] = useState<Record<string, string>>({});
  const [renderId, setRenderId] = useState<string | null>(null);
  const [renderStatus, setRenderStatus] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [health, setHealth] = useState<any>(null);
  const [assetErrors, setAssetErrors] = useState<Record<string, AssetError>>({});
  const [exportValidation, setExportValidation] = useState({
    status: "pending" as "pending" | "blocked" | "complete",
    errors: [] as string[],
  });
  const [validatedMedia, setValidatedMedia] = useState({ images: 0, audio: 0 });

  async function refreshDiagnostics() {
    try {
      const r = await fetch("/api/diagnostics", { cache: "no-store" });
      const d = await r.json();
      setHealth(d);
      return d;
    } catch {
      setHealth({ status: "error" });
      return null;
    }
  }

  useEffect(() => {
    void refreshDiagnostics();
  }, []);

  const words = useMemo(
    () => script.trim().split(/\s+/).filter(Boolean).length,
    [script]
  );

  function selectedMode(scene: Scene) {
    if (settings.visualMode === "ai") return "ai";
    if (settings.visualMode === "stock") return "stock";
    return scene.visualType === "stock" ? "stock" : "ai";
  }

  async function generateStoryboard() {
    setBusy(true);
    setProgress("A analisar o roteiro…");
    try {
      const r = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ script: script || demo, settings }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Erro ao analisar.");
      setData(d);
      setProgress(
        d.mode === "fallback"
          ? "Storyboard criado em modo local."
          : "Storyboard criado com IA."
      );
    } catch (e) {
      setProgress(e instanceof Error ? e.message : "Erro inesperado.");
    } finally {
      setBusy(false);
    }
  }

  function parseApiError(d: any, fallback: string, stage: string): AssetError {
    return {
      code: String(d?.code || (stage === "image" ? "IMAGE_PROVIDER_ERROR" : "TTS_PROVIDER_ERROR")),
      message: String(d?.error || fallback),
      stage,
      provider: d?.provider,
      retryable: Boolean(d?.retryable),
      detail: d?.detail,
    };
  }

  async function generateVisual(
    scene: Scene,
    errorSink?: (error: AssetError) => void
  ): Promise<string | null> {
    setProgress("A gerar visual da cena " + scene.index + "…");
    let reported = false;

    const report = (error: AssetError) => {
      reported = true;
      setAssetErrors((v) => ({ ...v, [scene.id]: error }));
      errorSink?.(error);
    };

    try {
      const mode = selectedMode(scene);
      const prompt = mode === "stock"
        ? (scene.searchQueries?.[0] || scene.visualPrompt || scene.narration)
        : scene.visualPrompt || scene.narration;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 70000);
      let r: Response;
      try {
        r = await fetch("/api/visuals", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt,
            stockQuery: scene.searchQueries?.[0] || "",
            mode,
            aspectRatio: settings.aspectRatio,
            style: settings.style,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        report(parseApiError(d, "Não foi possível gerar o visual.", "image"));
        setProgress(String(d?.code || "IMAGE_PROVIDER_ERROR") + ": " + String(d?.error || "Erro visual."));
        return null;
      }

      const selected = d.selected;
      const imageUrl = d.imageUrl || selected?.imageUrl;
      if (!imageUrl) {
        report({
          code: "IMAGE_RESPONSE_EMPTY",
          message: "A API respondeu sem uma imagem utilizável.",
          stage: "image",
          provider: d.source || "OpenAI",
          retryable: false,
        });
        return null;
      }

      setVisuals((v) => ({ ...v, [scene.id]: imageUrl }));
      setVisualMeta((v) => ({
        ...v,
        [scene.id]: d.source + (selected?.license ? " • " + selected.license : ""),
      }));

      if (d.warning && d.originalProviderError) {
        report({
          code: String(d.originalProviderError.code || "IMAGE_FALLBACK_USED"),
          message: String(d.warning),
          stage: "image",
          provider: "Wikimedia Commons",
          retryable: false,
          detail: String(d.originalProviderError.message || "") +
            " | fallback=" + String(d.fallbackQuery || ""),
        });
      } else {
        setAssetErrors((v) => {
          const next = { ...v };
          delete next[scene.id];
          return next;
        });
      }

      setProgress("Visual da cena " + scene.index + " pronto.");
      return imageUrl;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Erro de rede ao gerar visual.";
      const isTimeout = message.toLowerCase().includes("abort");
      const error: AssetError = {
        code: isTimeout ? "BROWSER_NETWORK_TIMEOUT" : "IMAGE_PROVIDER_ERROR",
        message: isTimeout ? "O pedido visual excedeu o tempo limite do browser." : message,
        stage: "image",
        retryable: true,
      };
      if (!reported) report(error);
      setProgress(error.code + ": " + error.message);
      return null;
    }
  }

  async function generatePreviewVisuals() {
    if (!data) return;
    setBusy(true);
    const target = data.scenes.slice(0, 8);
    for (let i = 0; i < target.length; i++) {
      setProgress("Visuais " + (i + 1) + "/" + target.length + "…");
      await generateVisual(target[i]);
    }
    setBusy(false);
    setProgress("Pré-visualização visual concluída.");
  }

  async function generateVoice(
    scene: Scene,
    errorSink?: (error: AssetError) => void
  ): Promise<string | null> {
    setProgress("A gerar voz da cena " + scene.index + "…");
    let reported = false;

    const report = (error: AssetError) => {
      reported = true;
      setAssetErrors((v) => ({ ...v, [scene.id]: error }));
      errorSink?.(error);
    };

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 70000);
      let r: Response;
      try {
        r = await fetch("/api/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: scene.narration,
            voice: settings.voice,
            speed: 1,
          }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      // IMPORTANT: only parse JSON for error responses. A successful TTS
      // response is binary audio, so parsing it as JSON would consume the
      // response body and make r.blob() fail.
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        const error = parseApiError(d, "Erro de voz.", "audio");
        report(error);
        setProgress(error.code + ": " + error.message);
        return null;
      }

      let blob: Blob;
      try {
        blob = await readValidAudioResponse(r);
      } catch (error) {
        report({
          code: "AUDIO_RESPONSE_INVALID",
          message: error instanceof Error ? error.message : "A resposta TTS é inválida.",
          stage: "audio",
          provider: "OpenAI",
          retryable: false,
        });
        return null;
      }

      const url = URL.createObjectURL(blob);
      const old = voices[scene.id];
      if (old) URL.revokeObjectURL(old);
      setVoices((v) => ({ ...v, [scene.id]: url }));
      setAssetErrors((v) => {
        const next = { ...v };
        delete next[scene.id];
        return next;
      });
      setProgress("Voz da cena " + scene.index + " pronta. Voz gerada por IA.");
      return url;
    } catch (e) {
      const message = e instanceof Error ? e.message : "Erro de rede ao gerar voz.";
      const isTimeout = message.toLowerCase().includes("abort");
      const error: AssetError = {
        code: isTimeout ? "BROWSER_NETWORK_TIMEOUT" : "TTS_PROVIDER_ERROR",
        message: isTimeout ? "O pedido TTS excedeu o tempo limite do browser." : message,
        stage: "audio",
        retryable: true,
      };
      if (!reported) report(error);
      setProgress(error.code + ": " + error.message);
      return null;
    }
  }

  async function downloadCaptions(format: "srt" | "vtt") {
    if (!data) return;
    const r = await fetch("/api/captions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenes: data.scenes, format }),
    });
    if (!r.ok) {
      setProgress("Não foi possível criar as legendas.");
      return;
    }
    downloadText("captions." + format, await r.text());
    setProgress("Legendas " + format.toUpperCase() + " exportadas.");
  }

  function exportProject() {
    if (!data) return;
    const payload = {
      app: "AI Video Factory",
      version: "0.2",
      settings,
      analysis: data,
      visualAssets: visuals,
      visualSources: visualMeta,
      voiceScenes: Object.keys(voices),
      exportedAt: new Date().toISOString(),
    };
    downloadText("ai-video-project.json", JSON.stringify(payload, null, 2));
    setProgress("Projeto exportado em JSON.");
  }

  async function fetchExportAsset(url: string) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const r = url.startsWith("data:")
        ? await fetch(url, { signal: controller.signal })
        : await fetch("/api/asset-proxy?url=" + encodeURIComponent(url), { signal: controller.signal });

      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(
          String(d?.code || "IMAGE_DOWNLOAD_ERROR") + ": " +
          String(d?.error || "Não foi possível descarregar uma imagem.")
        );
      }

      const contentType = String(r.headers.get("content-type") || "").split(";")[0].toLowerCase();
      const blob = await r.blob();
      const bytes = new Uint8Array(await blob.arrayBuffer());

      if (!blob.size || !isImageBytes(bytes, contentType)) {
        throw new Error(
          "IMAGE_DOWNLOAD_ERROR: o ficheiro descarregado não é uma imagem válida (" +
          (contentType || "Content-Type ausente") + ")."
        );
      }

      return blob;
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") {
        throw new Error("IMAGE_DOWNLOAD_ERROR: timeout no download da imagem.");
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async function normalizeImageToJpeg(blob: Blob) {
    const type = String(blob.type || "").split(";")[0].toLowerCase();
    if (type === "image/jpeg") return blob;

    const objectUrl = URL.createObjectURL(blob);
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve(image);
        image.onerror = () => reject(new Error("IMAGE_CONVERSION_ERROR: o browser não conseguiu descodificar a imagem."));
        image.src = objectUrl;
      });

      if (!img.naturalWidth || !img.naturalHeight) {
        throw new Error("IMAGE_CONVERSION_ERROR: imagem sem dimensões utilizáveis.");
      }

      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("IMAGE_CONVERSION_ERROR: canvas indisponível no browser.");

      ctx.drawImage(img, 0, 0);
      const jpeg = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob((value) => value ? resolve(value) : reject(new Error("IMAGE_CONVERSION_ERROR: não foi possível criar JPEG.")), "image/jpeg", 0.9);
      });

      const bytes = new Uint8Array(await jpeg.arrayBuffer());
      if (!isImageBytes(bytes, "image/jpeg")) {
        throw new Error("IMAGE_CONVERSION_ERROR: JPEG resultante inválido.");
      }

      return jpeg;
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  }

  async function fetchCaptionText(format: "srt" | "vtt") {
    const r = await fetch("/api/captions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ scenes: data?.scenes || [], format }),
    });
    if (!r.ok) throw new Error("Não foi possível gerar as legendas.");
    return r.text();
  }

  function slugify(value: string) {
    return value
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .toUpperCase() || "PROJETO";
  }

  async function exportCapCutPackage() {
    if (!data || packageBusy) return;

    setPackageBusy(true);
    setBusy(true);
    setAssetErrors({});
    setValidatedMedia({ images: 0, audio: 0 });
    setExportValidation({ status: "pending", errors: [] });

    try {
      const storyboardErrors = validateStoryboard(data.scenes);
      setExportValidation({ status: "pending", errors: [] });
      if (storyboardErrors.length) {
        setExportValidation({ status: "blocked", errors: storyboardErrors });
        throw new Error("EXPORTAÇÃO BLOQUEADA — storyboard inválido.\\n\\n" + storyboardErrors.join("\\n"));
      }

      const zip = new JSZip();
      const imageMap: Record<string, string> = { ...visuals };
      const voiceMap: Record<string, string> = { ...voices };
      const imageBlobs: Record<string, Blob> = {};
      const audioBlobs: Record<string, Blob> = {};
      const validationErrors: string[] = [];
      const generationErrors: Record<string, AssetError[]> = {};

      const addGenerationError = (sceneId: string, error: AssetError) => {
        generationErrors[sceneId] = [...(generationErrors[sceneId] || []), error];
      };

      for (let i = 0; i < data.scenes.length; i++) {
        const scene = data.scenes[i];
        const sceneLabel = "Cena " + String(scene.index).padStart(3, "0");
        setProgress("A preparar assets " + (i + 1) + "/" + data.scenes.length + "…");

        if (!imageMap[scene.id]) {
          const url = await generateVisual(scene, (error) => addGenerationError(scene.id, error));
          if (url) imageMap[scene.id] = url;
        }

        if (!voiceMap[scene.id]) {
          const url = await generateVoice(scene, (error) => addGenerationError(scene.id, error));
          if (url) voiceMap[scene.id] = url;
        }

        const imageUrl = imageMap[scene.id];
        if (!imageUrl) {
          const details = (generationErrors[scene.id] || []).filter((e) => e.stage === "image");
          validationErrors.push(
            sceneLabel + ": imagem em falta." +
            (details.length ? " Causa: " + details[details.length - 1].code + " — " + details[details.length - 1].message : "")
          );
        } else {
          try {
            const imageBlob = await fetchExportAsset(imageUrl);
            imageBlobs[scene.id] = await normalizeImageToJpeg(imageBlob);
            setValidatedMedia((v) => ({ ...v, images: v.images + 1 }));
          } catch (e) {
            validationErrors.push(
              sceneLabel + ": imagem não pôde ser descarregada (" +
              (e instanceof Error ? e.message : "erro desconhecido") + ")."
            );
          }
        }

        const voiceUrl = voiceMap[scene.id];
        if (!voiceUrl) {
          const details = (generationErrors[scene.id] || []).filter((e) => e.stage === "audio");
          validationErrors.push(
            sceneLabel + ": áudio em falta." +
            (details.length ? " Causa: " + details[details.length - 1].code + " — " + details[details.length - 1].message : "")
          );
        } else {
          try {
            const audioResponse = await fetch(voiceUrl);
            if (!audioResponse.ok) throw new Error("AUDIO_DOWNLOAD_ERROR: resposta " + audioResponse.status + ".");
            const contentType = String(audioResponse.headers.get("content-type") || "").split(";")[0].toLowerCase();
            const audioBlob = await audioResponse.blob();
            const audioBytes = new Uint8Array(await audioBlob.arrayBuffer());
            if (!audioBlob.size || !isMp3Bytes(audioBytes, contentType)) {
              throw new Error("AUDIO_DOWNLOAD_ERROR: ficheiro de áudio vazio, não-MP3 ou Content-Type inválido.");
            }
            audioBlobs[scene.id] = new Blob([audioBytes], { type: "audio/mpeg" });
            setValidatedMedia((v) => ({ ...v, audio: v.audio + 1 }));
          } catch (e) {
            validationErrors.push(
              sceneLabel + ": áudio não pôde ser descarregado (" +
              (e instanceof Error ? e.message : "erro desconhecido") + ")."
            );
          }
        }
      }

      const totalScenes = data.scenes.length;
      const validImages = Object.keys(imageBlobs).length;
      const validAudio = Object.keys(audioBlobs).length;

      if (validImages !== totalScenes) validationErrors.push("Imagens: " + validImages + "/" + totalScenes + " válidas.");
      if (validAudio !== totalScenes) validationErrors.push("Áudio: " + validAudio + "/" + totalScenes + " válidos.");

      if (validationErrors.length > 0) {
        setExportValidation({ status: "blocked", errors: validationErrors });
        throw new Error(
          "EXPORTAÇÃO BLOQUEADA — o projeto não está 100% completo.\\n\\n" +
          validationErrors.slice(0, 20).join("\\n") +
          (validationErrors.length > 20 ? "\\n… e mais " + (validationErrors.length - 20) + " erro(s)." : "")
        );
      }

      const srt = await fetchCaptionText("srt");
      const vtt = await fetchCaptionText("vtt");
      const srtErrors = validateCaptionText(srt, "srt", totalScenes);
      const vttErrors = validateCaptionText(vtt, "vtt", totalScenes);
      if (srtErrors.length || vttErrors.length) {
        const captionErrors = [...srtErrors, ...vttErrors];
        setExportValidation({ status: "blocked", errors: captionErrors });
        throw new Error(
          "EXPORTAÇÃO BLOQUEADA — legendas inválidas.\\n\\n" +
          captionErrors.join("\\n")
        );
      }

      let cursor = 0;
      const timeline = data.scenes.map((scene) => {
        const start = cursor;
        const duration = Math.max(1, Number(scene.duration) || 0);
        const end = cursor + duration;
        cursor = end;
        return {
          scene: scene.index,
          start,
          end,
          duration,
          image: "media/images/" + String(scene.index).padStart(3, "0") + ".jpg",
          audio: "media/audio/" + String(scene.index).padStart(3, "0") + ".mp3",
          narration: scene.narration,
          camera: scene.camera,
          transition: scene.transition,
          visualSource: visualMeta[scene.id] || selectedMode(scene),
        };
      });

      const timelineErrors = validateTimeline(timeline, totalScenes);
      if (timelineErrors.length) {
        setExportValidation({ status: "blocked", errors: timelineErrors });
        throw new Error("EXPORTAÇÃO BLOQUEADA — timeline inválida.\\n\\n" + timelineErrors.join("\\n"));
      }

      const fullScript = data.scenes.map((s) => s.narration.trim()).join("\n\n");
      if (!fullScript.trim()) {
        setExportValidation({ status: "blocked", errors: ["full-script vazio."] });
        throw new Error("EXPORTAÇÃO BLOQUEADA — full-script vazio.");
      }

      const csvEscape = (value: string | number) => '"' + String(value).replace(/"/g, '""') + '"';
      const csv = [
        "scene,start_seconds,end_seconds,duration_seconds,image,audio,narration",
        ...timeline.map((item) =>
          [
            item.scene,
            item.start.toFixed(2),
            item.end.toFixed(2),
            item.duration.toFixed(2),
            item.image,
            item.audio,
            item.narration,
          ].map(csvEscape).join(",")
        ),
      ].join("\n");

      const guide = [
        "AI VIDEO FACTORY — PACOTE CAPCUT",
        "",
        "VALIDAÇÃO: 100% COMPLETA",
        "Este pacote só foi criado porque todas as cenas passaram na validação.",
        "",
        "Formato: " + settings.aspectRatio,
        "Resolução alvo: " + settings.resolution,
        "FPS: 30",
        "Idioma: " + settings.language,
        "",
        "CONTEÚDO",
        "- media/images/: uma imagem válida por cena.",
        "- media/audio/: uma narração MP3 válida por cena.",
        "- captions.srt / captions.vtt: legendas.",
        "- timeline.csv: tempos e assets.",
        "- storyboard.json: storyboard e diagnóstico.",
        "- full-script.txt: roteiro completo.",
        "- VALIDACAO-100.txt: prova da validação.",
      ].join("\n");

      for (const scene of data.scenes) {
        const number = String(scene.index).padStart(3, "0");
        zip.file("media/images/" + number + ".jpg", imageBlobs[scene.id]);
        zip.file("media/audio/" + number + ".mp3", audioBlobs[scene.id]);
      }

      zip.file("captions.srt", srt);
      zip.file("captions.vtt", vtt);
      zip.file("timeline.csv", csv);
      zip.file("storyboard.json", JSON.stringify({
        app: "AI Video Factory",
        version: "0.5-capcut-100-percent-diagnostics",
        validation: {
          status: "100%",
          scenes: totalScenes,
          images: validImages,
          audio: validAudio,
          captions: "SRT + VTT",
          timeline: timeline.length,
        },
        settings,
        analysis: data,
        visualSources: visualMeta,
        generationErrors,
        exportedAt: new Date().toISOString(),
      }, null, 2));
      zip.file("full-script.txt", fullScript);
      zip.file("GUIA-CAPCUT.txt", guide);
      zip.file("VALIDACAO-100.txt", [
        "EXPORTAÇÃO VALIDADA: 100%",
        "",
        "Cenas: " + totalScenes + "/" + totalScenes,
        "Imagens válidas: " + validImages + "/" + totalScenes,
        "Áudios válidos: " + validAudio + "/" + totalScenes,
        "Legendas: SRT + VTT válidos",
        "Timeline: " + timeline.length + "/" + totalScenes,
        "",
        "REGRA: se qualquer asset estivesse em falta ou inválido, o ZIP não seria criado.",
      ].join("\n"));

      setProgress("100% validado. A compactar o projeto…");
      const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
      if (!blob.size) throw new Error("EXPORTAÇÃO BLOQUEADA — ZIP vazio.");

      const verifiedZip = await JSZip.loadAsync(blob);
      const requiredFiles = [
        ...data.scenes.flatMap((scene) => {
          const number = String(scene.index).padStart(3, "0");
          return ["media/images/" + number + ".jpg", "media/audio/" + number + ".mp3"];
        }),
        "captions.srt",
        "captions.vtt",
        "timeline.csv",
        "storyboard.json",
        "full-script.txt",
        "GUIA-CAPCUT.txt",
        "VALIDACAO-100.txt",
      ];
      const missingFiles: string[] = [];
      for (const filename of requiredFiles) {
        const entry = verifiedZip.file(filename);
        if (!entry) {
          missingFiles.push("Ficheiro ZIP em falta: " + filename);
          continue;
        }
        const bytes = await entry.async("uint8array");
        if (!bytes.length) missingFiles.push("Ficheiro ZIP vazio: " + filename);
        if (filename.startsWith("media/images/") && !isImageBytes(bytes, "image/jpeg")) {
          missingFiles.push("Imagem ZIP inválida: " + filename);
        }
        if (filename.startsWith("media/audio/") && !isMp3Bytes(bytes, "audio/mpeg")) {
          missingFiles.push("Áudio ZIP inválido: " + filename);
        }
      }

      if (missingFiles.length) {
        setExportValidation({ status: "blocked", errors: missingFiles });
        throw new Error("EXPORTAÇÃO BLOQUEADA — verificação final do ZIP falhou.\\n\\n" + missingFiles.join("\\n"));
      }

      setExportValidation({ status: "complete", errors: [] });

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "VYNKO_" + slugify(data.title) + "_CAPCUT.zip";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setProgress("100% completo — pacote CapCut pronto com " + totalScenes + "/" + totalScenes + " cenas.");
    } catch (e) {
      const message = e instanceof Error ? e.message : "Falha ao criar o pacote CapCut.";
      setExportValidation({
        status: "blocked",
        errors: message.split("\\n").filter(Boolean).slice(0, 20),
      });
      setProgress(message);
    } finally {
      setPackageBusy(false);
      setBusy(false);
    }
  }

  async function startRender() {
    if (!data) return;
    setRenderStatus("A preparar render…");
    try {
      const scenes = data.scenes.map((s) => ({
        ...s,
        visualUrl: visuals[s.id],
      }));
      const r = await fetch("/api/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scenes,
          aspectRatio: settings.aspectRatio,
          fps: 30,
          subtitles: settings.subtitles,
        }),
      });
      const d = await r.json();
      if (!r.ok) {
        setRenderStatus(d.error || "Render cloud não configurado.");
        return;
      }
      const id = d.render?.id;
      setRenderId(id || null);
      setRenderStatus(id ? "Render iniciado. A acompanhar…" : "Pedido enviado.");
      if (id) pollRender(id);
    } catch (e) {
      setRenderStatus(e instanceof Error ? e.message : "Erro de render.");
    }
  }

  async function pollRender(id: string) {
    for (let i = 0; i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const r = await fetch("/api/render?id=" + encodeURIComponent(id));
      const d = await r.json();
      if (d.status === "succeeded") {
        setRenderStatus("MP4 pronto.");
        return;
      }
      if (d.status === "failed") {
        setRenderStatus("Render falhou: " + (d.error_message || "erro desconhecido"));
        return;
      }
      setRenderStatus("Render: " + String(d.status || "a processar") + "…");
    }
    setRenderStatus("Render ainda está a processar. O job continua no provedor.");
  }

  const scenes = data?.scenes || [];
  const visibleScenes = showAll ? scenes : scenes.slice(0, 20);
  const visualCount = Object.keys(visuals).length;
  const voiceCount = Object.keys(voices).length;

  return (
    <div className="app">
      <header>
        <div className="brand">✦ <span>AI</span> VIDEO FACTORY</div>
        <div className="header-right">
          Long-form YouTube Studio
          <span className="health-chip">AI {health?.status === "ready" ? "READY" : health?.status === "degraded" ? "CHECK" : "CONFIGURE"}</span>
          <span className="health-chip">IMG {health?.image?.available ? "READY" : "CHECK"}</span>
          <span className="health-chip">TTS {health?.tts?.available ? "READY" : "CHECK"}</span>
        </div>
      </header>

      <main className="wrap">
        <section className="hero">
          <div>
            <div className="eyebrow">Production pipeline</div>
            <h1>Do roteiro ao vídeo.</h1>
            <p>Analisa, planeia, gera visuais, cria voz e prepara o render numa única oficina.</p>
          </div>
          <button onClick={() => setScript(demo)}>Carregar demo</button>
        </section>

        <section className="pipeline">
          {[
            ["01", "Roteiro", data ? "pronto" : "à espera"],
            ["02", "Storyboard", data ? "pronto" : "à espera"],
            ["03", "Visuais", visualCount + "/" + scenes.length],
            ["04", "Voz", voiceCount + "/" + scenes.length],
            ["05", "Legendas", data ? "SRT / VTT" : "à espera"],
            ["06", "MP4", renderStatus || "provider"],
          ].map(([n, label, state]) => (
            <div className="pipe" key={n}>
              <span>{n}</span><b>{label}</b><small>{state}</small>
            </div>
          ))}
        </section>

        <div className="grid">
          <section className="panel">
            <div className="ph"><b>Roteiro</b><span className="badge">{words} palavras</span></div>
            <div className="pb">
              <textarea
                className="script"
                value={script}
                onChange={(e) => setScript(e.target.value)}
                placeholder="Cole aqui o roteiro completo de 15–35 minutos…"
              />
              <div className="stats">
                <span>Duração estimada: {fmt((words / 150) * 60)}</span>
                <span>{settings.aspectRatio} • {settings.resolution}</span>
              </div>
            </div>
          </section>

          <aside className="panel">
            <div className="ph"><b>Produção</b><span className="badge">V2</span></div>
            <div className="pb settings">
              <div className="field"><label>Idioma</label><select value={settings.language} onChange={(e) => setSettings({ ...settings, language: e.target.value })}><option>Português (Portugal)</option><option>English</option><option>Español</option></select></div>
              <div className="field"><label>Voz <em>IA</em></label><select value={settings.voice} onChange={(e) => setSettings({ ...settings, voice: e.target.value })}><option value="marin">Masculina • marin</option><option value="cedar">Masculina • cedar</option><option value="onyx">Masculina • onyx</option></select></div>
              <div className="field"><label>Visuais</label><div className="seg">{["hybrid","ai","stock"].map(v => <button key={v} className={settings.visualMode===v ? "active" : ""} onClick={() => setSettings({ ...settings, visualMode:v })}>{v==="hybrid"?"Híbrido":v==="ai"?"Só IA":"Só stock"}</button>)}</div></div>
              <div className="field"><label>Formato</label><select value={settings.aspectRatio} onChange={(e) => setSettings({ ...settings, aspectRatio:e.target.value })}><option>16:9</option><option>9:16</option><option>1:1</option></select></div>
              <div className="field"><label>Estilo</label><select value={settings.style} onChange={(e) => setSettings({ ...settings, style:e.target.value })}><option>Documentário</option><option>Educacional</option><option>News</option><option>Mistério</option><option>Ciência</option></select></div>
              <div className="field checkbox"><label><input type="checkbox" checked={settings.subtitles} onChange={(e) => setSettings({ ...settings, subtitles:e.target.checked })}/> Legendas no render</label></div>
              <button className="primary" onClick={generateStoryboard} disabled={busy}>{busy ? "A PROCESSAR…" : "✦ GERAR STORYBOARD"}</button>
              {data && <button className="secondary" onClick={generatePreviewVisuals} disabled={busy}>🖼 GERAR 8 VISUAIS DE PRÉ-VISUALIZAÇÃO</button>}
              <div className="status">{progress || "Pronto."}</div>
            </div>
          </aside>
        </div>

        {data && (
          <>
            <section className="panel results">
              <div className="ph"><div><b>{data.title}</b><small className="subline">{data.summary}</small></div><span className="ok">READY</span></div>
              <div className="pb">
                <div className="metrics">
                  <div className="metric"><b>{data.scenes.length}</b><small>cenas</small></div>
                  <div className="metric"><b>{fmt(data.estimatedDuration)}</b><small>duração</small></div>
                  <div className="metric"><b>{data.wordCount}</b><small>palavras</small></div>
                  <div className="metric"><b>{visualCount}</b><small>visuais</small></div>
                </div>
              </div>
              <div className="toolbar">
                <button onClick={() => downloadCaptions("srt")}>↓ SRT</button>
                <button onClick={() => downloadCaptions("vtt")}>↓ VTT</button>
                <button onClick={exportProject}>↓ Projeto JSON</button>
                <button className="secondary" onClick={exportCapCutPackage} disabled={busy || packageBusy}>📦 GERAR PROJETO CAPCUT</button>
                <button className="primary small" onClick={startRender}>🎬 RENDER MP4</button>
              </div>
              {renderStatus && <div className="render-box"><b>{renderStatus}</b>{renderId && <small>Job: {renderId}</small>}</div>}
              <div className={"validation-box " + exportValidation.status}>
                <div className="validation-title">VALIDAÇÃO DO PROJETO</div>
                <div className="validation-grid">
                  <span>Storyboard <b>{data.scenes.length}/{data.scenes.length}</b></span>
                  <span>Imagens <b>{validatedMedia.images}/{data.scenes.length}</b></span>
                  <span>Áudio <b>{validatedMedia.audio}/{data.scenes.length}</b></span>
                  <span>SRT <b>{exportValidation.status === "complete" ? "✓ válido" : "pendente"}</b></span>
                  <span>VTT <b>{exportValidation.status === "complete" ? "✓ válido" : "pendente"}</b></span>
                  <span>Timeline <b>{exportValidation.status === "complete" ? data.scenes.length + "/" + data.scenes.length : "pendente"}</b></span>
                </div>
                <div className="validation-status">
                  {exportValidation.status === "complete"
                    ? "100% COMPLETO"
                    : exportValidation.status === "blocked"
                      ? "EXPORTAÇÃO BLOQUEADA"
                      : "VALIDAÇÃO PENDENTE"}
                </div>
                {exportValidation.errors.length > 0 && (
                  <div className="validation-errors">{exportValidation.errors.slice(0, 8).map((error, i) => <div key={i}>✗ {error}</div>)}</div>
                )}
              </div>
              <div className="pb">
                <div className="scenes">
                  {visibleScenes.map((s) => (
                    <article className="scene" key={s.id}>
                      <div className="thumb">
                        {visuals[s.id] ? <img src={visuals[s.id]} alt="" /> : <span>SCENE {String(s.index).padStart(2, "0")}</span>}
                      </div>
                      <div className="scene-main">
                        <div><span className="badge">{selectedMode(s)}</span><span className="badge">{s.duration}s</span>{visualMeta[s.id] && <span className="badge">{visualMeta[s.id]}</span>}</div>
                        <p>{s.narration}</p>
                        <small className="muted">🎥 {s.camera} · {s.transition}</small>
                        {assetErrors[s.id] && (
                          <small className="error-text">
                            ⚠ {assetErrors[s.id].code}: {assetErrors[s.id].message}
                          </small>
                        )}
                        {voices[s.id] && <audio controls src={voices[s.id]} />}
                      </div>
                      <div className="scene-actions">
                        <button onClick={() => generateVisual(s)}>🖼</button>
                        <button onClick={() => generateVoice(s)}>🔊</button>
                      </div>
                    </article>
                  ))}
                </div>
                {scenes.length > 20 && <button className="more" onClick={() => setShowAll(!showAll)}>{showAll ? "Mostrar menos" : "Mostrar todas as cenas"}</button>}
              </div>
              <div className="disclosure">🔒 As vozes são geradas por IA. Os visuais de stock mostram a fonte/licença quando disponível.</div>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
