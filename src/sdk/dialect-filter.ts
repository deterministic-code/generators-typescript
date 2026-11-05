export function filterChunks(
  chunks: Record<string, string>,
  dialects: string[],
  joiner = "\n",
): string {
  return dialects
    .filter((d) => chunks[d])
    .map((d) => chunks[d])
    .join(joiner);
}
