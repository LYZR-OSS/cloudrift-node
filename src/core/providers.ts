import { CloudRiftError } from "./errors.js";

export function normalizeChoice<T extends string>(
  label: string,
  value: string,
  choices: readonly T[],
  aliases: Partial<Record<string, T>> = {},
): T {
  const normalized = value.trim().toLowerCase();
  const aliased = aliases[normalized];
  if (aliased) {
    return aliased;
  }

  if ((choices as readonly string[]).includes(normalized)) {
    return normalized as T;
  }

  const options = choices.map((choice) => `'${choice}'`).join(", ");
  throw new CloudRiftError(`Unknown ${label}: ${JSON.stringify(value)}. Choose ${options}.`);
}
