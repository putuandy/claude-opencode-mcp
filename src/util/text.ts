import type { Finding } from "../types/index.js";

const ESCAPE = String.fromCharCode(27);
const ANSI_PATTERN = new RegExp(`${ESCAPE}\\[[0-9;]*[A-Za-z]`, "g");

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

export interface TruncateResult {
  text: string;
  truncated: boolean;
}

export function truncate(text: string, maxChars: number): TruncateResult {
  if (maxChars <= 0 || text.length <= maxChars) {
    return { text, truncated: false };
  }
  const head = Math.max(0, maxChars - 200);
  const tail = Math.max(0, Math.min(120, Math.floor(maxChars / 20)));
  const omitted = text.length - head - tail;
  const marker = `\n\n… [truncated ${omitted} characters] …\n\n`;
  return {
    text: `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ""}`,
    truncated: true,
  };
}

export function oneLine(text: string, maxChars = 300): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars)}…` : collapsed;
}

const FINDINGS_HEADING = /^#{1,6}\s*(findings?|issues?|bugs?|risks?|problems?)\b.*$/im;
const ANY_HEADING = /^#{1,6}\s+(.+?)\s*$/gm;

function sectionsFromMarkdown(text: string): Array<{ title: string; body: string }> {
  const sections: Array<{ title: string; body: string }> = [];
  const matches = [...text.matchAll(ANY_HEADING)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    if (!match) continue;
    const title = (match[1] ?? "").trim();
    const start = (match.index ?? 0) + match[0].length;
    const next = matches[index + 1];
    const end = next && next.index !== undefined ? next.index : text.length;
    sections.push({ title, body: text.slice(start, end).trim() });
  }
  return sections;
}

export function extractFindings(text: string, maxFindings = 50): Finding[] {
  if (!text) return [];
  const sections = sectionsFromMarkdown(text);
  const target = sections.find((section) =>
    /^(findings?|issues?|bugs?|risks?|problems?)\b/i.test(section.title),
  );
  if (!target && !FINDINGS_HEADING.test(text)) return [];

  const body = target ? target.body : "";
  const findings: Finding[] = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    const bullet = line.match(/^[-*+]\s+(.*)$/) ?? line.match(/^\d+[.)]\s+(.*)$/);
    if (!bullet) continue;
    const item = (bullet[1] ?? "").trim();
    if (!item) continue;

    let severity: string | undefined;
    let rest = item;
    const explicitSeverity = rest.match(/^\[(severity:\s*)?([a-z]+)\]\s*/i);
    if (explicitSeverity) {
      severity = explicitSeverity[2]?.toLowerCase();
      rest = rest.slice(explicitSeverity[0].length);
    } else {
      const prefix = rest.match(/^(critical|high|medium|low|info|warning|error)\s*[:—-]\s*/i);
      if (prefix) {
        severity = prefix[1]?.toLowerCase();
        rest = rest.slice(prefix[0].length);
      }
    }

    let file: string | undefined;
    let lineNumber: number | undefined;
    const locationMatches = [...rest.matchAll(/\(([^()]+)\)/g)];
    const locationMatch = locationMatches[locationMatches.length - 1];
    if (locationMatch && locationMatch.index !== undefined) {
      const inner = locationMatch[1] ?? "";
      const withLine = inner.match(/^([\w@./\\-]+?):(\d+)(?::\d+)?$/);
      if (withLine) {
        file = withLine[1]?.trim();
        lineNumber = Number.parseInt(withLine[2] ?? "", 10);
      } else if (/^[\w@./\\-]+\.[A-Za-z0-9]+(?::\d+)?$/.test(inner.trim())) {
        const bare = inner.trim().match(/^([\w@./\\-]+?)(?::(\d+))?$/);
        file = bare?.[1]?.trim();
        lineNumber = bare?.[2] ? Number.parseInt(bare[2], 10) : undefined;
      }
      if (file) {
        rest =
          `${rest.slice(0, locationMatch.index)}${rest.slice(locationMatch.index + locationMatch[0].length)}`.trim();
      }
    }

    const separator = rest.match(/^(.+?)\s+[—–-]\s+(.+)$/);
    let title = rest;
    let detail: string | undefined;
    if (separator) {
      title = separator[1]?.trim() ?? rest;
      detail = separator[2]?.trim();
    }

    // Only bullets that carry a severity or a location are real findings;
    // prose bullets such as "All good elsewhere" are left to the summary.
    if (!severity && !file) continue;
    if (!title) continue;
    findings.push({
      ...(severity ? { severity } : {}),
      title: title.slice(0, 500),
      ...(detail ? { detail: detail.slice(0, 2000) } : {}),
      ...(file ? { file } : {}),
      ...(lineNumber !== undefined && !Number.isNaN(lineNumber) ? { line: lineNumber } : {}),
    });
    if (findings.length >= maxFindings) break;
  }
  return findings;
}

export function summarizeText(text: string, maxChars: number): string {
  const cleaned = stripAnsi(text).trim();
  return truncate(cleaned, maxChars).text;
}

export function requestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}
