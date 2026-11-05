export const DEFAULT_PREPROCESSING_PROMPT =
  "You are preparing text for a text-to-speech system. " +
  "You will receive a message from a conversation enclosed in quadruple backticks. " +
  "Summarize it in one single very short sentence, two at most. " +
  "Use a dry, matter-of-fact tone. " +
  "Do not use any markdown formatting, just plain text. " +
  "Prefer words over symbols or abbreviations, as this will be read aloud. " +
  "Output only the sentence, nothing else.";

export const SPEED_VALUES = [
  "0.5",
  "0.75",
  "1.0",
  "1.25",
  "1.5",
  "1.75",
  "2.0",
  "2.25",
  "2.5",
  "2.75",
  "3.0",
] as const;

export function speedToIndex(speed: number): number {
  const idx = SPEED_VALUES.findIndex((s) => Number.parseFloat(s) === speed);
  return idx >= 0 ? idx : 0;
}

/** Human-readable "(language gender)" hint for a Kokoro voice id like af_heart. */
export function voiceHint(name: string): string {
  const langMap: Record<string, string> = {
    a: "American",
    b: "British",
    j: "Japanese",
    z: "Mandarin",
    e: "Spanish",
    f: "French",
    h: "Hindi",
    i: "Italian",
    p: "Brazilian",
  };
  const genderMap: Record<string, string> = { f: "female", m: "male" };
  const lang = langMap[name[0] ?? ""] ?? "";
  const gender = genderMap[name[1] ?? ""] ?? "";
  if (lang && gender) return `${lang} ${gender}`;
  if (gender) return gender;
  return lang;
}

export function extractTextContent(content: unknown[] | undefined): string {
  if (!content) return "";
  return (content as Array<{ type: string; text?: string }>)
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("\n");
}

/**
 * Strip markdown syntax so the synthesizer speaks words, not symbols.
 * Fenced code blocks are dropped entirely (spoken code is noise); inline
 * code keeps its text; links/images keep their label/alt.
 */
export function cleanTextForSpeech(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/(^|[\s([{])\*\*\*([^*\n]+?)\*\*\*(?=$|[\s.,!?;:)}\]])/g, "$1$2")
    .replace(/(^|[\s([{])\*\*([^*\n]+?)\*\*(?=$|[\s.,!?;:)}\]])/g, "$1$2")
    .replace(/(^|[\s([{])\*([^*\n]+?)\*(?=$|[\s.,!?;:)}\]])/g, "$1$2")
    .replace(/(^|[\s([{])___([^_\n]+?)___(?=$|[\s.,!?;:)}\]])/g, "$1$2")
    .replace(/(^|[\s([{])__([^_\n]+?)__(?=$|[\s.,!?;:)}\]])/g, "$1$2")
    .replace(/(^|[\s([{])_([^_\n]+?)_(?=$|[\s.,!?;:)}\]])/g, "$1$2")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/^\s*(?:[-*_]\s*){3,}$/gm, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
