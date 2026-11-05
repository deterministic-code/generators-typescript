export const COMMENT_STYLES = ["none", "simple", "description"] as const;
export type CommentStyle = (typeof COMMENT_STYLES)[number];
export const DEFAULT_COMMENT_STYLE: CommentStyle = "simple";

export function normalizeCommentStyle(value: unknown): CommentStyle {
  if (typeof value !== "string") return DEFAULT_COMMENT_STYLE;
  return (COMMENT_STYLES as readonly string[]).includes(value)
    ? (value as CommentStyle)
    : DEFAULT_COMMENT_STYLE;
}

export interface RenderDocCommentOptions {
  style?: unknown;
  summary?: unknown;
  lines?: unknown;
  language?: string;
}

export function renderDocComment({
  style,
  summary,
  lines,
  language = "typescript",
}: RenderDocCommentOptions = {}): string {
  const resolved = normalizeCommentStyle(style);
  if (resolved === "none") return "";
  const safeSummary =
    typeof summary === "string" && summary.length > 0
      ? summary
      : "Generated symbol.";

  if (resolved === "simple") {
    if (language === "rust") {
      return `/// ${safeSummary}\n`;
    }
    if (language === "python") {
      return `"""${safeSummary}"""\n`;
    }
    return `/** ${safeSummary} */\n`;
  }

  if (!Array.isArray(lines) || lines.length !== 3) {
    throw new Error(
      `renderDocComment: style "description" requires exactly 3 lines, got ${
        Array.isArray(lines) ? lines.length : typeof lines
      }`,
    );
  }

  if (language === "rust") {
    const allLines = [safeSummary, ...lines];
    return allLines.map((l) => `/// ${l}`).join("\n") + "\n";
  }

  if (language === "python") {
    const allLines = [safeSummary, ...lines];
    return `"""${allLines.join("\n")}\n"""\n`;
  }

  const body = [safeSummary, ...lines].map((l) => ` * ${l}`).join("\n");
  return `/**\n${body}\n */\n`;
}
