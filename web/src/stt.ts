// Voice-to-text via Web Speech Recognition. Returns a controller that fires
// onText for each interim/final transcript and onEnd when stopped.

type SR = typeof globalThis extends { SpeechRecognition: infer T }
  ? T
  : typeof globalThis extends { webkitSpeechRecognition: infer T2 }
  ? T2
  : unknown;

export type SttController = {
  stop: () => void;
  isSupported: boolean;
};

export function startDictation(opts: {
  onText: (text: string, isFinal: boolean) => void;
  onEnd?: () => void;
  onError?: (err: string) => void;
  lang?: string;
}): SttController {
  const W = window as unknown as { SpeechRecognition?: SR; webkitSpeechRecognition?: SR };
  const Ctor = W.SpeechRecognition || W.webkitSpeechRecognition;
  if (!Ctor) {
    return {
      stop: () => undefined,
      isSupported: false,
    };
  }
  const rec = new (Ctor as new () => {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    onresult: (e: { resultIndex: number; results: ArrayLike<{ 0: { transcript: string }; isFinal: boolean }> }) => void;
    onend: () => void;
    onerror: (e: { error: string }) => void;
    start: () => void;
    stop: () => void;
  })();

  rec.continuous = true;
  rec.interimResults = true;
  rec.lang = opts.lang ?? "en-US";
  rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (!r) continue;
      const text = r[0].transcript;
      opts.onText(text, r.isFinal);
    }
  };
  rec.onend = () => opts.onEnd?.();
  rec.onerror = (e) => opts.onError?.(e.error);
  rec.start();
  return {
    stop: () => rec.stop(),
    isSupported: true,
  };
}
