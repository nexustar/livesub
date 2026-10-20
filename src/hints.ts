// /api/hints — research a scene description and produce a keyword list. Port of
// _generate_hints_claude / _generate_hints_gemini from server.py. The backend
// registry and choice (HINTS_BACKENDS, pickHintsBackend) live in config.ts so
// /api/backends can reuse them.

import Anthropic from "@anthropic-ai/sdk";
import { GoogleGenAI } from "@google/genai";
import type { HintsBackend } from "./config.js";
import { buildHintsSystemPrompt, parseHintsResponse } from "./prompts.js";
import { log } from "./util.js";

export interface HintsResult {
  scene: string;
  glossary: string;
  searchesUsed: number;
  model: string;
  stopReason: string | null;
}

export function generateHints(backend: HintsBackend, description: string, sourceLang: string): Promise<HintsResult> {
  const apiKey = process.env[backend.api_key_env] ?? "";
  return backend.sdk === "gemini"
    ? generateHintsGemini(apiKey, backend.model, description, sourceLang)
    : generateHintsAnthropic(apiKey, backend.base_url, backend.model, backend.effort, description, sourceLang);
}

// Run the hints flow via the Messages API + the web_search server tool
// (Anthropic, or DeepSeek's compatible endpoint).
async function generateHintsAnthropic(
  apiKey: string,
  baseURL: string | undefined,
  model: string,
  effort: "low" | "medium" | "high" | undefined,
  description: string,
  sourceLang: string,
): Promise<HintsResult> {
  const client = new Anthropic({ apiKey, baseURL });
  const msg = await client.messages.create({
    model,
    ...(effort ? { output_config: { effort } } : {}),
    // Thinking counts against max_tokens; 1024 truncated the glossary.
    max_tokens: 4096,
    system: buildHintsSystemPrompt(sourceLang),
    tools: [
      {
        // Server-side web search tool. The model decides when to call it;
        // max_uses caps cost. Newer tool versions (20260209+) were slower
        // and costlier for a 3-search budget. DeepSeek ignores max_uses.
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 3,
      },
    ],
    messages: [{ role: "user", content: `Scene description: ${description}` }],
  });
  // Concatenate all text blocks; count web_search server_tool_use blocks.
  const textParts: string[] = [];
  let searchesUsed = 0;
  for (const block of msg.content) {
    if (block.type === "text") textParts.push(block.text);
    else if (block.type === "server_tool_use" && block.name === "web_search") searchesUsed += 1;
  }
  if (msg.stop_reason === "max_tokens") log.warning(`hints: ${model} hit max_tokens, glossary may be truncated`);
  const { scene, glossary } = parseHintsResponse(textParts.join("").trim());
  return { scene, glossary, searchesUsed, model, stopReason: msg.stop_reason ?? null };
}

// Run the hints flow via Gemini Flash + google_search grounding.
async function generateHintsGemini(apiKey: string, model: string, description: string, sourceLang: string): Promise<HintsResult> {
  const client = new GoogleGenAI({ apiKey });
  const resp = await client.models.generateContent({
    model,
    contents: `Scene description: ${description}`,
    config: {
      systemInstruction: buildHintsSystemPrompt(sourceLang),
      tools: [{ googleSearch: {} }],
    },
  });
  const raw = (resp.text ?? "").trim();
  // web_search_queries is the list of actual queries Gemini issued — its length
  // is the analogue of Claude's server_tool_use count.
  let searchesUsed = 0;
  let finishReason: string | null = null;
  const cand = resp.candidates?.[0];
  if (cand) {
    finishReason = cand.finishReason ? String(cand.finishReason) : null;
    if (finishReason === "MAX_TOKENS") log.warning(`hints: ${model} hit max tokens, glossary may be truncated`);
    const queries = cand.groundingMetadata?.webSearchQueries ?? [];
    searchesUsed = queries.length;
  }
  const { scene, glossary } = parseHintsResponse(raw);
  return { scene, glossary, searchesUsed, model, stopReason: finishReason };
}
