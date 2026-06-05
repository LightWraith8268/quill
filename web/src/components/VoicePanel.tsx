// Per-character voice engine. Lists characters, builds a cached voice signature
// for each (diction, rhythm, tics, sample lines), and rewrites a pasted passage
// so the selected character's dialogue matches their established voice.

import { useCallback, useEffect, useState } from "react";
import { api, type VoiceListItem, type VoiceProfile } from "../api.ts";

export function VoicePanel({ storyId }: { storyId: number }) {
  const [voices, setVoices] = useState<VoiceListItem[] | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [profile, setProfile] = useState<VoiceProfile | null>(null);
  const [building, setBuilding] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const [passage, setPassage] = useState("");
  const [rewriting, setRewriting] = useState(false);
  const [rewritten, setRewritten] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .voices(storyId)
      .then((r) => setVoices(r.voices))
      .catch((e: Error) => setErr(e.message));
  }, [storyId]);

  useEffect(() => {
    setVoices(null);
    setSelected(null);
    setProfile(null);
    setRewritten(null);
    load();
  }, [load]);

  const select = async (eid: number) => {
    setSelected(eid);
    setProfile(null);
    setRewritten(null);
    setErr(null);
    try {
      const p = await api.voiceProfile(storyId, eid);
      setProfile(p);
    } catch (e) {
      setErr((e as Error).message);
    }
  };

  const build = async () => {
    if (selected == null || building) return;
    setBuilding(true);
    setErr(null);
    try {
      const p = await api.voiceBuild(storyId, selected);
      setProfile(p);
      load();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBuilding(false);
    }
  };

  const rewrite = async () => {
    if (selected == null || !passage.trim() || rewriting) return;
    setRewriting(true);
    setErr(null);
    setRewritten(null);
    try {
      const r = await api.voiceRewrite(storyId, selected, passage);
      setRewritten(r.rewritten);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setRewriting(false);
    }
  };

  return (
    <div className="space-y-3">
      {err && (
        <div className="bg-red-100 text-red-900 dark:bg-red-900/40 dark:text-red-200 text-sm p-3 rounded">
          {err}
        </div>
      )}

      {voices && voices.length === 0 && (
        <div className="card text-center text-muted py-8 text-sm">
          No characters in canon yet. Extract canon first (Canon → Re-extract), then
          build voice signatures here.
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        {voices?.map((v) => (
          <button
            key={v.entityId}
            onClick={() => select(v.entityId)}
            className={`text-xs px-2 py-1 rounded border ${
              selected === v.entityId
                ? "bg-teal text-paper border-teal"
                : "border-muted/30 hover:border-tealBright"
            }`}
            title={`${v.facts} fact(s)`}
          >
            {v.name}
            {v.hasProfile && <span className="ml-1 text-tealBright">●</span>}
          </button>
        ))}
      </div>

      {selected != null && (
        <div className="card space-y-3">
          <div className="flex items-center gap-2">
            <span className="font-display text-lg">
              {profile?.name ?? "Voice"}
            </span>
            {profile?.updatedAt && (
              <span className="text-xs text-muted">
                profiled {new Date(profile.updatedAt).toLocaleDateString()}
              </span>
            )}
            <button
              className="btn btn-ghost text-xs ml-auto"
              onClick={build}
              disabled={building}
              title="Analyze this character's facts + manuscript lines to derive a voice signature"
            >
              {building ? "Analyzing…" : profile?.signature ? "Rebuild" : "Build voice signature"}
            </button>
          </div>

          {profile?.signature ? (
            <>
              <p className="text-sm whitespace-pre-wrap">{profile.signature}</p>
              {profile.examples.length > 0 && (
                <ul className="text-sm space-y-1 border-l-2 border-tealBright/40 pl-3">
                  {profile.examples.map((e, i) => (
                    <li key={i} className="italic">
                      “{e}”
                    </li>
                  ))}
                </ul>
              )}

              <div className="border-t border-muted/20 pt-3 space-y-2">
                <label className="text-xs text-muted">
                  Rewrite a passage to match {profile.name}'s voice
                </label>
                <textarea
                  className="input w-full font-ui resize-none text-sm"
                  rows={4}
                  value={passage}
                  onChange={(e) => setPassage(e.target.value)}
                  placeholder={`Paste a passage with ${profile.name}'s dialogue…`}
                />
                <button
                  className="btn btn-primary text-sm"
                  onClick={rewrite}
                  disabled={rewriting || !passage.trim()}
                >
                  {rewriting ? "Rewriting…" : "Rewrite to voice"}
                </button>
                {rewritten != null && (
                  <div className="card bg-paper/40 dark:bg-bg/60">
                    <div className="flex items-center mb-1">
                      <span className="text-xs text-muted">rewritten</span>
                      <button
                        className="btn btn-ghost text-xs ml-auto"
                        onClick={() => navigator.clipboard?.writeText(rewritten)}
                      >
                        Copy
                      </button>
                    </div>
                    <pre className="whitespace-pre-wrap font-ui text-sm">{rewritten}</pre>
                  </div>
                )}
              </div>
            </>
          ) : (
            <p className="text-muted text-sm">
              No voice signature yet — click{" "}
              <span className="text-tealBright">Build voice signature</span>.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
