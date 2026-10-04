import test from "node:test";
import assert from "node:assert/strict";
import {
  isImageBytes,
  isMp3Bytes,
  validateCaptionText,
  validateStoryboard,
  validateTimeline,
} from "../src/lib/export-validation";

const validScenes = [
  {
    id: "scene-1",
    index: 1,
    narration: "Primeira cena.",
    duration: 4,
    visualType: "stock",
    visualPrompt: "Lisboa",
    searchQueries: ["Lisboa"],
    camera: "push",
    transition: "cut",
  },
  {
    id: "scene-2",
    index: 2,
    narration: "Segunda cena.",
    duration: 5,
    visualType: "ai-image",
    visualPrompt: "cidade",
    searchQueries: ["cidade"],
    camera: "pan",
    transition: "cut",
  },
];

test("storyboard valid passes", () => {
  assert.deepEqual(validateStoryboard(validScenes), []);
});

test("storyboard missing narration/duration/media prompt is blocked", () => {
  const errors = validateStoryboard([{
    id: "scene-1",
    index: 1,
    narration: "",
    duration: 0,
    visualType: "broken",
    visualPrompt: "",
    searchQueries: [""],
    camera: "",
    transition: "",
  }]);
  assert.ok(errors.length >= 6);
});

test("SRT requires one valid cue per scene", () => {
  const srt = [
    "1",
    "00:00:00,000 --> 00:00:04,000",
    "Primeira cena.",
    "",
    "2",
    "00:00:04,000 --> 00:00:09,000",
    "Segunda cena.",
  ].join("\n");
  assert.deepEqual(validateCaptionText(srt, "srt", 2), []);
  assert.ok(validateCaptionText(srt.split("\n").slice(0, 3).join("\n"), "srt", 2).length > 0);
});

test("VTT requires WEBVTT, correct count, order and non-empty payload", () => {
  const valid = [
    "WEBVTT",
    "",
    "1",
    "00:00:00.000 --> 00:00:04.000",
    "Primeira.",
    "",
    "2",
    "00:00:04.000 --> 00:00:09.000",
    "Segunda.",
  ].join("\n");
  assert.deepEqual(validateCaptionText(valid, "vtt", 2), []);

  const overlap = [
    "WEBVTT",
    "",
    "1",
    "00:00:00.000 --> 00:00:04.000",
    "Primeira.",
    "",
    "2",
    "00:00:03.000 --> 00:00:09.000",
    "Segunda.",
  ].join("\n");
  assert.ok(validateCaptionText(overlap, "vtt", 2).some((x) => x.includes("sobrepõe")));
});

test("timeline requires contiguous complete scenes", () => {
  const timeline = [
    { scene: 1, start: 0, end: 4, duration: 4, image: "media/images/001.jpg", audio: "media/audio/001.mp3" },
    { scene: 2, start: 4, end: 9, duration: 5, image: "media/images/002.jpg", audio: "media/audio/002.mp3" },
  ];
  assert.deepEqual(validateTimeline(timeline, 2), []);
  assert.ok(validateTimeline([{ ...timeline[1], start: 6 }], 2).length > 0);
});

test("real image signatures are accepted and HTML is rejected", () => {
  const jpeg = new Uint8Array([0xff,0xd8,0xff,0xe0,0x00,0x10,0x4a,0x46,0x49,0x46,0x00,0x01]);
  const html = new TextEncoder().encode("<html>error</html>");
  assert.equal(isImageBytes(jpeg, "image/jpeg"), true);
  assert.equal(isImageBytes(html, "text/html"), false);
  assert.equal(isImageBytes(new Uint8Array(), "image/jpeg"), false);
});

test("real MP3 signatures are accepted and empty audio is rejected", () => {
  const id3 = new Uint8Array([0x49,0x44,0x33,0x04,0x00,0x00]);
  const frame = new Uint8Array([0xff,0xfb,0x90,0x64]);
  assert.equal(isMp3Bytes(id3, "audio/mpeg"), true);
  assert.equal(isMp3Bytes(frame, "audio/mpeg"), true);
  assert.equal(isMp3Bytes(new Uint8Array(), "audio/mpeg"), false);
  assert.equal(isMp3Bytes(new Uint8Array([0x49,0x44,0x33,0x04]), "text/html"), false);
});

import test from "node:test";
import assert from "node:assert/strict";
import { readValidAudioResponse } from "../src/lib/media-http";

const mp3Bytes = new Uint8Array([0x49,0x44,0x33,0x04,0x00,0x00]);

test("binary TTS success response is read as audio, not JSON", async () => {
  const response = new Response(mp3Bytes, {
    status: 200,
    headers: { "Content-Type": "audio/mpeg" },
  });

  const blob = await readValidAudioResponse(response);
  assert.equal(blob.type, "audio/mpeg");
  assert.equal(blob.size, mp3Bytes.length);
});

test("regression: parsing successful audio as JSON consumes the body", async () => {
  const response = new Response(mp3Bytes, {
    status: 200,
    headers: { "Content-Type": "audio/mpeg" },
  });

  await response.json().catch(() => undefined);
  await assert.rejects(() => response.blob());
});

test("invalid TTS MIME is rejected before accepting the body", async () => {
  const response = new Response(mp3Bytes, {
    status: 200,
    headers: { "Content-Type": "text/html" },
  });

  await assert.rejects(() => readValidAudioResponse(response), /AUDIO_RESPONSE_INVALID/);
});
