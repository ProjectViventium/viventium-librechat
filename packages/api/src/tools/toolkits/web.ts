import { Tools, replaceSpecialVars } from 'librechat-data-provider';

/** Builds the web search tool context with citation format instructions. */
export function buildWebSearchContext({
  includeCurrentTime = true,
}: { includeCurrentTime?: boolean } = {}): string {
  /* === VIVENTIUM START ===
   * Feature: Stable native-session tool authority.
   * Purpose: Native conversation providers receive volatile time through the invocation-fresh
   * turn header, so their durable tool authority must omit it. Direct providers keep the exact
   * existing context by default.
   * === VIVENTIUM END === */
  const header = includeCurrentTime
    ? `# \`${Tools.web_search}\`:\nCurrent Date & Time: ${replaceSpecialVars({ text: '{{iso_datetime}}' })}\n\n`
    : `# \`${Tools.web_search}\`:\n\n`;
  return `${header}**Execute immediately without preface.** After search, provide a brief summary addressing the query directly, then structure your response with clear Markdown formatting (## headers, lists, tables). Cite sources properly, tailor tone to query type, and provide comprehensive details.

**CITATION FORMAT - UNICODE ESCAPE SEQUENCES ONLY:**
Use these EXACT escape sequences (copy verbatim): \\ue202 (before each anchor), \\ue200 (group start), \\ue201 (group end), \\ue203 (highlight start), \\ue204 (highlight end)

Anchor pattern: \\ue202turn{N}{type}{index} where N=turn number, type=search|news|image|ref, index=0,1,2...

**Examples (copy these exactly):**
- Single: "Statement.\\ue202turn0search0"
- Multiple: "Statement.\\ue202turn0search0\\ue202turn0news1"
- Group: "Statement. \\ue200\\ue202turn0search0\\ue202turn0news1\\ue201"
- Highlight: "\\ue203Cited text.\\ue204\\ue202turn0search0"
- Image: "See photo\\ue202turn0image0."

**CRITICAL:** Output escape sequences EXACTLY as shown. Do NOT substitute with † or other symbols. Place anchors AFTER punctuation. Cite every non-obvious fact/quote. NEVER use markdown links, [1], footnotes, or HTML tags.`.trim();
}
