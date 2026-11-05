import type { TObject } from "typebox";

export type SpeechAudio =
  | { kind: "buffered"; wav: Buffer }
  | {
      kind: "stream";
      format: { encoding: "pcm-s16le"; sampleRate: number; channels: number };
      chunks: AsyncIterable<Uint8Array>;
    };

export type SpeechRequest = {
  text: string;
  voice?: string;
} & (
  | { speed?: number; stability?: never; similarity?: never }
  | { speed?: never; stability?: number; similarity?: number }
);

export interface SpeechProvider {
  synthesize(request: SpeechRequest, signal?: AbortSignal): Promise<SpeechAudio>;
  dispose(): Promise<void>;
}

export type ElevenLabsConfig = {
  apiKey?: string;
  model: "eleven_v4" | "eleven_v4_turbo";
  voice: string;
  stability: number;
  similarity: number;
};

export type VoicePage = {
  voices: Array<{ id: string; name: string; description: string }>;
  nextPage?: string;
};

export type SpeechToolDescription = {
  parameters: TObject;
  description: string;
  guidelines: string[];
};
