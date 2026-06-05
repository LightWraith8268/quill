// Per-character voice engine. Derives a compact "voice signature" for a
// character (diction, rhythm, verbal tics, sample lines) from their canon facts
// and manuscript appearances, caches it, and uses it to rewrite a passage so
// that character's dialogue matches their established voice.

import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { getStory } from "./stories.ts";
import { listGraph, entityFacts } from "./knowledge/store.ts";
import { retrieveCanon } from "./knowledge/retrieve.ts";
import { claudeOnce } from "./agents/claude.ts";
import { parseJsonLoose } from "./knowledge/extract.ts";
import { makeRecorder } from "./usage.ts";

export type VoiceProfile = {
  entityId: number;
  name: string;
  signature: string;
  examples: string[];
  updatedAt: number | null;
};

export type VoiceListItem = {
  entityId: number;
  name: string;
  facts: number;
  hasProfile: boolean;
};

export function listVoices(db: DB, series: string | null): VoiceListItem[] {
  const graph = listGraph(db, series);
  const profiled = new Set(
    db
      .query<{ entity_id: number }, [string | null, string | null]>(
        `SELECT v.entity_id FROM kb_character_voice v
         JOIN kb_entities e ON e.id = v.entity_id
         WHERE e.series IS ? OR e.series = ?`
      )
      .all(series, series)
      .map((r) => r.entity_id)
  );
  return graph.entities
    .filter((e) => e.kind === "character")
    .map((e) => ({
      entityId: e.id,
      name: e.name,
      facts: e.facts,
      hasProfile: profiled.has(e.id),
    }))
    .sort((a, b) => b.facts - a.facts);
}

export function getVoiceProfile(db: DB, entityId: number): VoiceProfile | null {
  const ent = db
    .query<{ name: string; series: string | null }, [number]>(
      "SELECT name, series FROM kb_entities WHERE id = ?"
    )
    .get(entityId);
  if (!ent) return null;
  const row = db
    .query<{ signature: string; examples: string | null; updated_at: number }, [number]>(
      "SELECT signature, examples, updated_at FROM kb_character_voice WHERE entity_id = ?"
    )
    .get(entityId);
  if (!row) {
    return { entityId, name: ent.name, signature: "", examples: [], updatedAt: null };
  }
  return {
    entityId,
    name: ent.name,
    signature: row.signature,
    examples: row.examples ? row.examples.split("\n").filter(Boolean) : [],
    updatedAt: row.updated_at,
  };
}

const PROFILE_SYS = `You are a dialogue coach. From the material about ONE character, distill a compact, usable VOICE SIGNATURE another writer could follow to make that character sound consistent. Output STRICT JSON only:
{
  "signature": "4-7 sentences: diction & register, sentence rhythm, verbal tics/catchphrases, vocabulary, what they avoid, emotional default",
  "examples": ["2-5 short representative lines of THEIR dialogue (verbatim if present in the material, else faithful inventions)"]
}
Focus on how they SPEAK. Be specific and prescriptive, not generic.`;

async function gatherCharacterMaterial(
  cfg: Config,
  db: DB,
  storyId: number,
  entityId: number,
  name: string
): Promise<string> {
  const story = getStory(db, storyId);
  const facts = entityFacts(db, entityId)
    .map((f) => `- (${f.canon_weight}) ${f.claim}`)
    .join("\n");
  let passages = "";
  try {
    const items = await retrieveCanon(cfg, db, `${name} dialogue — what ${name} says, how ${name} speaks`, {
      scope: { series: story?.series ?? null, book: story?.name ?? null },
      factK: 0,
      chunkK: 8,
      useRerank: true,
      onEmbedUsage: makeRecorder(db, "voyage_embed", storyId),
      onRerankUsage: makeRecorder(db, "voyage_rerank", storyId),
    });
    passages = items
      .filter((i) => i.kind === "chunk")
      .map((i) => i.text)
      .join("\n---\n")
      .slice(0, 12_000);
  } catch {
    /* retrieval optional */
  }
  return [
    `CHARACTER: ${name}`,
    facts ? `\nKNOWN FACTS:\n${facts}` : "",
    passages ? `\nMANUSCRIPT PASSAGES (mentioning or spoken by ${name}):\n${passages}` : "",
  ].join("\n");
}

export async function buildVoiceProfile(
  cfg: Config,
  db: DB,
  storyId: number,
  entityId: number
): Promise<VoiceProfile> {
  const ent = db
    .query<{ name: string; series: string | null }, [number]>(
      "SELECT name, series FROM kb_entities WHERE id = ?"
    )
    .get(entityId);
  if (!ent) throw new Error(`entity ${entityId} not found`);

  const material = await gatherCharacterMaterial(cfg, db, storyId, entityId, ent.name);
  const recorder = makeRecorder(db, "claude", storyId);
  const text = await claudeOnce(`${PROFILE_SYS}\n\n=== MATERIAL ===\n${material}`, {
    cwd: cfg.VAULT_PATH,
    skipMcp: true,
    onUsage: (u) =>
      recorder({
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cachedInputTokens: u.cachedInputTokens,
        model: u.model,
      }),
  });

  const parsed = parseJsonLoose<{ signature?: string; examples?: string[] }>(text);
  const signature = (parsed?.signature ?? text).trim();
  const examples = Array.isArray(parsed?.examples) ? parsed!.examples!.filter(Boolean) : [];

  db.prepare<unknown, [number, string | null, string, string, number]>(
    `INSERT INTO kb_character_voice (entity_id, series, signature, examples, updated_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(entity_id) DO UPDATE SET
       signature = excluded.signature, examples = excluded.examples, updated_at = excluded.updated_at`
  ).run(entityId, ent.series, signature, examples.join("\n"), Date.now());

  return { entityId, name: ent.name, signature, examples, updatedAt: Date.now() };
}

export async function rewriteToVoice(
  cfg: Config,
  db: DB,
  storyId: number,
  entityId: number,
  text: string
): Promise<{ rewritten: string; name: string; model: string | null }> {
  let profile = getVoiceProfile(db, entityId);
  if (!profile || !profile.signature) {
    profile = await buildVoiceProfile(cfg, db, storyId, entityId);
  }

  const systemPrompt =
    "You are a line editor specializing in character voice. Rewrite the passage so that " +
    `${profile.name}'s DIALOGUE matches the voice signature below. Leave narration, action, ` +
    "and other characters' lines unchanged. Preserve meaning, plot, and beats — only adjust how " +
    `${profile.name} speaks. Output ONLY the rewritten passage: no commentary, no quotes around it, no fences.\n\n` +
    `=== ${profile.name.toUpperCase()} VOICE SIGNATURE ===\n${profile.signature}\n` +
    (profile.examples.length ? `\nSample lines:\n${profile.examples.map((e) => `- ${e}`).join("\n")}\n` : "");

  const recorder = makeRecorder(db, "claude", storyId);
  let model: string | null = null;
  const rewritten = await claudeOnce(`PASSAGE:\n${text}`, {
    systemPrompt,
    cwd: cfg.VAULT_PATH,
    skipMcp: true,
    onUsage: (u) => {
      model = u.model ?? model;
      recorder({
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cachedInputTokens: u.cachedInputTokens,
        model: u.model,
      });
    },
  });

  return { rewritten: rewritten.trim(), name: profile.name, model };
}
