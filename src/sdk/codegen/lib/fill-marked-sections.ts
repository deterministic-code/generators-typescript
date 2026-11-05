import { replaceMarkedBlockText } from "@deterministic-code/patch-merger";
import { SECTION_MARKERS } from "../../section-markers.ts";

type MarkerKey = keyof typeof SECTION_MARKERS;
type SectionMarker = (typeof SECTION_MARKERS)[MarkerKey];

/** Compose a runner file at generate time: replace each `DIALECT_*` marked section in `template` with its dialect block, then strip the BEGIN/END marker lines. The template keeps its markers (so it stays valid, readable source), but the generated runner carries no codegen markers — nothing re-reads them (migrate generates its runners filled in, not generate-then-patch). `sections` is `[[markerKey, block], …]`. */
export function fillMarkedSections(
  template: string,
  sections: Array<[MarkerKey, string]>,
): string {
  let content = template;
  for (const [markerKey, block] of sections) {
    const marker = SECTION_MARKERS[markerKey];
    content = replaceMarkedBlockText({
      original: content,
      startMarker: marker.start,
      endMarker: marker.end,
      block,
    });
    content = stripMarkerLines(content, marker);
  }
  return content;
}

function stripMarkerLines(content: string, marker: SectionMarker): string {
  return content
    .split("\n")
    .filter(
      (line) => !line.includes(marker.start) && !line.includes(marker.end),
    )
    .join("\n");
}
