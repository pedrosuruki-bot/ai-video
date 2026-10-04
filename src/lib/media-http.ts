import { isMp3Bytes } from "./export-validation";

export async function readValidAudioResponse(response: Response): Promise<Blob> {
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(
      String(data?.code || "AUDIO_DOWNLOAD_ERROR") + ": " +
      String(data?.error || "A resposta TTS falhou.")
    );
  }

  const contentType = String(response.headers.get("content-type") || "")
    .split(";")[0]
    .toLowerCase();

  if (contentType !== "audio/mpeg" && contentType !== "audio/mp3") {
    throw new Error("AUDIO_RESPONSE_INVALID: Content-Type inesperado.");
  }

  const blob = await response.blob();
  const bytes = new Uint8Array(await blob.arrayBuffer());

  if (!blob.size || !isMp3Bytes(bytes, contentType)) {
    throw new Error("AUDIO_RESPONSE_INVALID: áudio vazio ou MP3 inválido.");
  }

  return new Blob([bytes], { type: "audio/mpeg" });
}
