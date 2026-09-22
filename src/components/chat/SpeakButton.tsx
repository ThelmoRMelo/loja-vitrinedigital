// Botão "Ouvir" — camada adicional de TTS sobre a resposta em texto da ANIA.
// Gera o áudio somente ao toque do usuário e reutiliza o áudio na sessão.
// Também expõe playMessageSpeech/stopMessageSpeech para reprodução automática
// controlada pelo Chat.tsx — MESMA infraestrutura (cache, áudio único, voz).
import { useEffect, useRef, useState } from 'react';
import { Volume2, Loader2, Pause, Play } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';

type State = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

// Somente uma reprodução ativa por vez em toda a página
let currentAudio: HTMLAudioElement | null = null;

// Cache do áudio por mensagem, válido durante a sessão
const audioCache = new Map<string, string>();

// Versão limpa do texto apenas para leitura em voz alta
export function cleanTextForSpeech(raw: string): string {
  return raw
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'link disponível na conversa')
    .replace(/[*_~#>|]/g, ' ')
    .replace(/^\s*[-•]\s*/gm, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

interface SpeechConfig {
  voice?: string | null;
  instructions?: string | null;
  speed?: number | null;
}

function buildCacheKey(messageId: string, cfg: SpeechConfig): string {
  return `${messageId}|${cfg.voice || 'coral'}|${cfg.speed ?? 1}|${(cfg.instructions || '').length}`;
}

// Busca (ou reutiliza do cache) o src de áudio para a mensagem.
async function getSpeechSrc(messageId: string, text: string, cfg: SpeechConfig): Promise<string> {
  const cacheKey = buildCacheKey(messageId, cfg);
  const cached = audioCache.get(cacheKey);
  if (cached) return cached;

  const spoken = cleanTextForSpeech(text);
  if (!spoken) throw new Error('texto vazio após limpeza');

  const { data, error } = await supabase.functions.invoke('text-to-speech', {
    body: {
      text: spoken,
      ...(cfg.voice ? { voice: cfg.voice } : {}),
      ...(cfg.instructions ? { instructions: cfg.instructions } : {}),
      ...(cfg.speed ? { speed: cfg.speed } : {}),
    },
  });

  if (error) throw error;
  const base64 = (data as { audio?: string })?.audio;
  if (!base64) throw new Error('sem áudio');

  const src = `data:audio/mpeg;base64,${base64}`;
  audioCache.set(cacheKey, src);
  return src;
}

function playExclusive(audio: HTMLAudioElement): Promise<void> {
  if (currentAudio && currentAudio !== audio) currentAudio.pause();
  currentAudio = audio;
  return audio.play();
}

/**
 * Reprodução programática (áudio automático do chat).
 * Silenciosa por contrato: NUNCA lança erro para o chamador — falhas de TTS
 * ou bloqueio de autoplay do navegador são apenas registradas no console.
 */
export async function playMessageSpeech(
  messageId: string,
  text: string,
  cfg: SpeechConfig,
): Promise<void> {
  try {
    const src = await getSpeechSrc(messageId, text, cfg);
    const audio = new Audio(src);
    audio.onended = () => {
      if (currentAudio === audio) currentAudio = null;
    };
    await playExclusive(audio);
  } catch (err) {
    console.error('[AutoSpeak] erro ao reproduzir resposta:', err);
  }
}

/** Interrompe imediatamente qualquer áudio em reprodução (manual ou automático). */
export function stopMessageSpeech(): void {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio = null;
  }
}

interface SpeakButtonProps {
  messageId: string;
  text: string;
  /** Configurações de voz já carregadas pela aplicação (sem nova consulta ao banco). */
  voice?: string | null;
  instructions?: string | null;
  speed?: number | null;
}


export function SpeakButton({ messageId, text, voice, instructions, speed }: SpeakButtonProps) {
  const [state, setState] = useState<State>('idle');
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        if (currentAudio === audioRef.current) currentAudio = null;
      }
    };
  }, []);

  const attach = (audio: HTMLAudioElement) => {
    audio.onended = () => {
      setState('ended');
      if (currentAudio === audio) currentAudio = null;
    };
    audio.onpause = () => setState((s) => (s === 'playing' ? 'paused' : s));
    audio.onplay = () => setState('playing');
    audio.onerror = () => setState('error');
  };

  const play = async (audio: HTMLAudioElement) => {
    try {
      await playExclusive(audio);
      setState('playing');
    } catch {
      setState('error');
    }
  };

  const handleClick = async () => {
    const existing = audioRef.current;

    if (state === 'playing' && existing) {
      existing.pause();
      setState('paused');
      return;
    }

    if (existing && (state === 'paused' || state === 'ended')) {
      if (state === 'ended') existing.currentTime = 0;
      await play(existing);
      return;
    }

    const spoken = cleanTextForSpeech(text);
    if (!spoken) return;

    setState('loading');
    try {
      const src = await getSpeechSrc(messageId, text, { voice, instructions, speed });
      const audio = new Audio(src);
      audioRef.current = audio;
      attach(audio);
      await play(audio);
    } catch (err) {
      console.error('[SpeakButton] TTS error:', err);
      setState('error');
    }
  };

  const label =
    state === 'loading'
      ? 'Gerando áudio...'
      : state === 'playing'
        ? 'Pausar'
        : state === 'paused'
          ? 'Continuar'
          : state === 'ended'
            ? 'Ouvir novamente'
            : state === 'error'
              ? 'Tentar novamente'
              : 'Ouvir';

  const Icon =
    state === 'loading' ? Loader2 : state === 'playing' ? Pause : state === 'paused' ? Play : Volume2;

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={state === 'loading'}
      aria-label={label}
      className="mt-1.5 inline-flex items-center gap-1.5 min-h-[36px] px-2.5 py-1.5 rounded-full text-[12px] font-medium text-muted-foreground bg-foreground/5 hover:bg-foreground/10 active:scale-[0.97] transition disabled:opacity-70"
    >
      <Icon className={`w-3.5 h-3.5 ${state === 'loading' ? 'animate-spin' : ''}`} />
      {label}
    </button>
  );
}
