export type Settings = {
  language: string;
  voice: string;
  visualMode: string;
  aspectRatio: string;
  resolution: string;
  style: string;
  subtitles: boolean;
};

export type Scene = {
  id: string;
  index: number;
  narration: string;
  duration: number;
  visualType: string;
  visualPrompt: string;
  searchQueries: string[];
  camera: string;
  transition: string;
  visualUrl?: string;
  visualSource?: string;
  visualCredit?: string;
};

export type Analysis = {
  title: string;
  summary: string;
  wordCount: number;
  estimatedDuration: number;
  scenes: Scene[];
  mode?: string;
};
