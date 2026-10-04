"use client";

import { useEffect, useMemo, useState } from "react";
import JSZip from "jszip";
import type { Analysis, Scene, Settings } from "@/lib/types";

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
  const [health, setHealth] = useState<{openai:boolean;image:boolean;stock:boolean;render:boolean} | null>(null);

  useEffect(() => {
    fetch("/api/health").then((r) => r.json()).then(setHealth).catch(() => setHealth(null));
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

  async function generateVisual(scene: Scene): Promise<string | null> {
    setProgress("A gerar visual da cena " + scene.index + "…");
    try {
      const mode = selectedMode(scene);
      const prompt = mode === "stock"
        ? (scene.searchQueries?.[0] || scene.visualPrompt || scene.narration)
        : scene.visualPrompt || scene.narration;

      const r = await fetch("/api/visuals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt,
          mode,
          aspectRatio: settings.aspectRatio,
          style: settings.style,
        }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Não foi possível gerar o visual.");
      const selected = d.selected;
      const imageUrl = d.imageUrl || selected?.imageUrl;
      if (!imageUrl) throw new Error("A resposta não trouxe uma imagem.");
      setVisuals((v) => ({ ...v, [scene.id]: imageUrl }));
      setVisualMeta((v) => ({
        ...v,
        [scene.id]: d.source + (selected?.license ? " • " + selected.license : ""),
      }));
      setProgress("Visual da cena " + scene.index + " pronto.");
      return imageUrl;
    } catch (e) {
      setProgress(e instanceof Error ? e.message : "Erro visual.");
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

  async function generateVoice(scene: Scene): Promise<string | null> {
    setProgress("A gerar voz da cena " + scene.index + "…");
    try {
      const r = await fetch("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: scene.narration,
          voice: settings.voice,
          speed: 1,
        }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({ error: "Erro de voz." }));
        throw new Error(d.error);
      }
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const old = voices[scene.id];
      if (old) URL.revokeObjectURL(old);
      setVoices((v) => ({ ...v, [scene.id]: url }));
      setProgress("Voz da cena " + scene.index + " pronta. Voz gerada por IA.");
      return url;
    } catch (e) {
      setProgress(e instanceof Error ? e.message : "Erro de voz.");
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
    if (url.startsWith("data:")) {
      const r = await fetch(url);
      return r.blob();
    }
    const r = await fetch("/api/asset-proxy?url=" + encodeURIComponent(url));
    if (!r.ok) throw new Error("Não foi possível descarregar uma imagem.");
    return r.blob();
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

    try {
      const zip = new JSZip();
      const imageMap: Record<string, string> = { ...visuals };
      const voiceMap: Record<string, string> = { ...voices };

      for (let i = 0; i < data.scenes.length; i++) {
        const scene = data.scenes[i];
        setProgress("A preparar assets " + (i + 1) + "/" + data.scenes.length + "…");

        if (!imageMap[scene.id]) {
          const url = await generateVisual(scene);
          if (url) imageMap[scene.id] = url;
        }

        if (!voiceMap[scene.id]) {
          const url = await generateVoice(scene);
          if (url) voiceMap[scene.id] = url;
        }

        const imageUrl = imageMap[scene.id];
        if (imageUrl) {
          try {
            const imageBlob = await fetchExportAsset(imageUrl);
            zip.file("media/images/" + String(scene.index).padStart(3, "0") + ".jpg", imageBlob);
          } catch {
            zip.file(
              "media/images/" + String(scene.index).padStart(3, "0") + "-SOURCE.txt",
              imageUrl
            );
          }
        }

        const voiceUrl = voiceMap[scene.id];
        if (voiceUrl) {
          const audioBlob = await fetch(voiceUrl).then((x) => x.blob());
          zip.file("media/audio/" + String(scene.index).padStart(3, "0") + ".mp3", audioBlob);
        }
      }

      const srt = await fetchCaptionText("srt");
      const vtt = await fetchCaptionText("vtt");

      let cursor = 0;
      const timeline = data.scenes.map((scene) => {
        const start = cursor;
        const end = cursor + Math.max(1, Number(scene.duration) || 4);
        cursor = end;
        return {
          scene: scene.index,
          start,
          end,
          duration: end - start,
          image: "media/images/" + String(scene.index).padStart(3, "0") + ".jpg",
          audio: "media/audio/" + String(scene.index).padStart(3, "0") + ".mp3",
          narration: scene.narration,
          camera: scene.camera,
          transition: scene.transition,
          visualSource: visualMeta[scene.id] || selectedMode(scene),
        };
      });

      const csvEscape = (value: string | number) => {
        const text = String(value).replace(/"/g, '""');
        return '"' + text + '"';
      };

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
        "Este pacote foi preparado para montagem no CapCut.",
        "Formato: " + settings.aspectRatio,
        "Resolução alvo: " + settings.resolution,
        "FPS: 30",
        "Idioma: " + settings.language,
        "",
        "CONTEÚDO",
        "- media/images/: uma imagem por cena, em ordem numérica.",
        "- media/audio/: uma narração MP3 por cena, em ordem numérica.",
        "- captions.srt: legendas sincronizadas.",
        "- captions.vtt: versão WebVTT.",
        "- timeline.csv: início, fim, duração e ficheiros de cada cena.",
        "- storyboard.json: prompts, narrativa e definições.",
        "",
        "MONTAGEM",
        "1. Importe as imagens pela ordem numérica.",
        "2. Use timeline.csv para aplicar a duração indicada a cada imagem.",
        "3. Importe os MP3 de áudio correspondentes e alinhe-os pelos mesmos números.",
        "4. No CapCut Web/Desktop, importe captions.srt se quiser legendas editáveis.",
        "5. No iPhone, o CapCut Mobile não importa SRT diretamente; pode sincronizar um projeto criado no Web/Desktop.",
        "",
        "NOTA: as imagens podem ser IA ou stock. A fonte/licença aparece no storyboard.json.",
      ].join("\n");

      zip.file("captions.srt", srt);
      zip.file("captions.vtt", vtt);
      zip.file("timeline.csv", csv);
      zip.file("storyboard.json", JSON.stringify({
        app: "AI Video Factory",
        version: "0.3-capcut",
        settings,
        analysis: data,
        visualSources: visualMeta,
        exportedAt: new Date().toISOString(),
      }, null, 2));
      zip.file("full-script.txt", data.scenes.map((s) => s.narration).join("\n\n"));
      zip.file("GUIA-CAPCUT.txt", guide);

      setProgress("A compactar o projeto…");
      const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "VYNKO_" + slugify(data.title) + "_CAPCUT.zip";
      a.click();
      URL.revokeObjectURL(url);
      setProgress("Pacote CapCut pronto: imagens, voz, SRT, VTT e timeline.");
    } catch (e) {
      setProgress(e instanceof Error ? e.message : "Falha ao criar o pacote CapCut.");
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
        <div className="header-right">Long-form YouTube Studio <span className="health-chip">AI {health?.openai ? "READY" : "CONFIGURE"}</span><span className="health-chip">RENDER {health?.render ? "READY" : "OPTIONAL"}</span></div>
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
