import OpenAI from "openai";

let client: OpenAI | null = null;

export function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  return client ??= new OpenAI({
    apiKey,
    timeout: 45000,
    maxRetries: 0,
  });
}
