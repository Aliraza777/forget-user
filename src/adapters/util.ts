/** The address as given and lowercased, for services that match emails case-sensitively. */
export function emailVariants(email: string): string[] {
  const trimmed = email.trim();
  return [...new Set([trimmed, trimmed.toLowerCase()])];
}
