import { Type } from "typebox";
import { Check } from "typebox/value";
import type { SpeechRequest, SpeechToolDescription } from "./speech-provider.js";

const text = Type.String({ minLength: 1, description: "Text to speak aloud" });
const voice = Type.Optional(Type.String({ minLength: 1, description: "Voice ID; defaults to configured voice. Discover voices with speech_options." }));

export const kokoroDescription: SpeechToolDescription = {
  parameters: Type.Object({
    text, voice,
    speed: Type.Optional(Type.Number({ minimum: 0.5, maximum: 3, description: "Speaking speed multiplier" })),
  }, { additionalProperties: false }),
  description: "Speak text aloud using local Kokoro speech synthesis.",
  guidelines: ["Choose a voice and speed, or omit them to use configured defaults."],
};

export const elevenLabsDescription: SpeechToolDescription = {
  parameters: Type.Object({
    text, voice,
    stability: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: "Delivery consistency; lower values allow more variation" })),
    similarity: Type.Optional(Type.Number({ minimum: 0, maximum: 1, description: "Adherence to the reference voice" })),
  }, { additionalProperties: false }),
  description: "Speak text aloud with ElevenLabs. Text is sent to ElevenLabs and generation consumes account quota.",
  guidelines: [
    "Place delivery directions in text using single square brackets, for example [confident], [whispering], [chuckles], or [clears throat]. Tag adherence varies by voice and model.",
    "Omit voice, stability and similarity to use configured defaults. Discover voices with speech_options.",
  ],
};

export function validateSpeechRequest(description: SpeechToolDescription, request: SpeechRequest): void {
  if (!Check(description.parameters, request) || !request.text.trim()) {
    throw new Error("Invalid speech parameters. Use speech_options to inspect the active provider's controls.");
  }
}
