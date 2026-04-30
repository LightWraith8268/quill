// Browser Web Speech Synthesis. Pronunciation overrides via vault-stored map.

import { api } from "./api.ts";

let cachedMap: Record<string, string> | null = null;

async function getMap(): Promise<Record<string, string>> {
  if (cachedMap) return cachedMap;
  try {
    cachedMap = await api.pronunciationGet();
  } catch {
    cachedMap = {};
  }
  return cachedMap;
}

function applyPronunciation(text: string, map: Record<string, string>): string {
  let out = text;
  for (const [term, replacement] of Object.entries(map)) {
    if (!term) continue;
    const re = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
    out = out.replace(re, replacement);
  }
  return out;
}

let currentUtterance: SpeechSynthesisUtterance | null = null;

export async function readAloud(text: string, opts: { rate?: number; pitch?: number } = {}): Promise<void> {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    throw new Error("Speech synthesis not available in this browser.");
  }
  stopReading();
  const map = await getMap();
  const speech = applyPronunciation(text, map);
  const u = new SpeechSynthesisUtterance(speech);
  u.rate = opts.rate ?? 1;
  u.pitch = opts.pitch ?? 1;
  currentUtterance = u;
  window.speechSynthesis.speak(u);
}

export function stopReading(): void {
  if (typeof window === "undefined") return;
  window.speechSynthesis.cancel();
  currentUtterance = null;
}

export function isReading(): boolean {
  return typeof window !== "undefined" && window.speechSynthesis.speaking;
}

export function clearMapCache(): void {
  cachedMap = null;
}
