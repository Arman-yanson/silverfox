require('dotenv').config();
const express = require('express');
const multer = require('multer');
const mammoth = require('mammoth');
const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });
const anthropic = new Anthropic();

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Load guidelines once at startup; reload on SIGHUP if needed
let guidelinesContent = '';
function loadGuidelines() {
  try {
    guidelinesContent = fs.readFileSync(path.join(__dirname, 'guidelines.md'), 'utf-8');
  } catch {
    guidelinesContent = '*(No guidelines.md file found — add one to enable custom rules)*';
  }
}
loadGuidelines();
process.on('SIGHUP', loadGuidelines);

function buildSystemPrompt() {
  return `You are a legal compliance expert specialising in Australian Consumer Law (ACL) and financial services regulation. Analyse marketing copy for compliance issues.

AUSTRALIAN CONSUMER LAW — CHECK FOR:
- Misleading or deceptive conduct (s18 ACL)
- False representations about goods or services (s29 ACL)
- Misleading price representations — hidden fees, drip pricing, unclear GST/inclusions
- Comparative advertising claims that cannot be substantiated
- Misleading environmental or sustainability claims ("greenwashing")
- Unsolicited payment demands or bait advertising
- Unfair contract terms

FINANCIAL SERVICES COMPLIANCE — CHECK FOR:
- Unlicensed financial product advice (Corporations Act s766B)
- Unsubstantiated investment return projections (e.g. "earn 20% p.a.")
- Missing required disclaimers — FSG, PDS, TMD, general advice warning
- Misleading representations about risk (e.g. implying low risk for high-risk products)
- Past performance presented as indicative of future results
- "Get rich" style claims or guaranteed returns
- Testimonials used as financial advice without proper context

NRMA PRODUCT COMPLIANCE — CHECK FOR:
- Incorrect representation of cover levels — there are exactly 5 levels (Comprehensive Plus, Comprehensive, Comprehensive Basics, Third Party Fire and Theft, Third Party Property Damage); flag any copy that omits, misstates, or implies a different hierarchy
- Misrepresentation of excess conditions — multiple excess types can apply to a single claim; flag any copy that implies only one excess applies, that excess can be removed by paying additional premium, or that excess always applies (there are specific waiver scenarios)
- Discount claims that don't match the guidelines — Multi-Product, Relationship, and Online discounts have strict eligibility rules, percentage tiers, and exclusions; flag any specific percentage, eligibility claim, or implication of permanence that contradicts the guidelines

NRMA TONE OF VOICE — CHECK FOR (the NRMA Brand Identity Guidelines are the PRIMARY and authoritative standard for all tone of voice decisions; these rules override any general writing conventions where they conflict):

Apply checks in this order: NRMA TOV rules first, general rules second. Only raise a general writing issue where no NRMA-specific rule already governs it.

FOUR CREATIVE PRINCIPLES — flag violations of each:
- SMART: Copy must be thoughtful, incisive, factual and confident. Flag copy that is quippy, arrogant, condescending, or fails to use expertise to build trust with the reader.
- SIMPLE: Copy must use plain English and short sentences. Flag "assist" instead of "help", "additional" instead of "more", "lodge" instead of "make", or any unnecessarily complex language that has a simpler alternative.
- ACTIVE: Copy must use active voice and drive clear action. Flag passive constructions, CTAs that do not start with an action word, and copy that leaves the customer without a clear next step.
- EMPATHETIC: Copy must be warm, human and understanding. Flag formal, corporate or detached language. Flag "Dear [Name]" salutations — NRMA style requires "Hi [Name]".

CUSTOMER JOURNEY STAGE MISMATCHES — flag where the tone does not match the channel or stage:
- Campaign and awareness copy must be SMART — flag if not knowledge-led, confident or purposeful
- Quote flows and product pages must be SIMPLE — flag complex language or unclear option presentation
- Decision and purchase copy must be ACTIVE — flag passive voice or missing calls to action
- Claims and service copy must be EMPATHETIC — flag cold, detached or commanding language
- Renewal and offer emails must be ACTIVE — flag passive voice or absence of a clear CTA

CONTENT STYLE GUIDE VIOLATIONS — always flag:
- Title case in body copy (sentence case is required throughout)
- Full stops in headlines unless the headline is a complete sentence
- Semicolons or em-dashes anywhere in copy
- Dates in dd/xx/xxxx format (must be written in full: Monday 10 February 2025)
- Times without a colon — "9am" must be "9:00am" (exception: very space-constrained contexts)
- Acronyms not spelled out in full on first mention with the acronym in brackets
- Contractions avoided where plain English calls for them — always use "we've", "you'll", "here's", "let's"
- "A Help Company" written without title caps
- "A Help Company™" appearing without the trademark symbol in long-form copy
- "Help. Always." used as a tagline — this is not permitted in customer communications
- "help" capitalised in general copy or headlines

GRAMMAR AND PUNCTUATION — NRMA STYLE:
- No semicolons permitted
- No em-dashes permitted
- No full stops in headlines unless a complete sentence
- Oxford comma only when genuinely needed for clarity
- Ampersands only where space is very tight
- No ordinal indicators — "1st", "2nd" must be written "1", "2"
- No commas in dates

CUSTOM GUIDELINES:
${guidelinesContent}

Respond with ONLY a valid JSON object — no markdown, no preamble. Use this exact structure:
{
  "summary": "2–3 sentence overall assessment of the copy's compliance posture",
  "totalIssues": <integer>,
  "issues": [
    {
      "originalText": "exact verbatim text from the input that contains the issue",
      "issueType": "ACL" | "Financial Services" | "NRMA Product" | "Tone of Voice",
      "severity": "high" | "medium" | "low",
      "rule": "specific rule, section, or guideline violated",
      "issue": "clear explanation of why this copy is problematic",
      "suggestedFix": "revised version of the copy that resolves the issue"
    }
  ]
}

Severity:
- high: Likely to attract regulatory action, substantial fines, or cause significant consumer harm
- medium: Likely to attract regulatory scrutiny or cause consumer confusion
- low: Minor issue or best-practice improvement

Only flag genuine issues. If no issues, return an empty issues array. Do not invent problems.`;
}

// ─── Word doc: extract text ───────────────────────────────────────────────────

app.post('/api/extract-docx', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const result = await mammoth.extractRawText({ buffer: req.file.buffer });
    if (!result.value.trim()) {
      return res.status(422).json({ error: 'No readable text found in this document' });
    }
    res.json({ text: result.value });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Analyse: stream Claude response ─────────────────────────────────────────

app.post('/api/analyze', async (req, res) => {
  const { textItems } = req.body;

  let textContent = '';
  if (Array.isArray(textItems)) {
    textContent = textItems
      .filter(t => t.text?.trim())
      .map((t, i) => `[${i + 1}] ${t.text.trim()}`)
      .join('\n\n');
  } else if (typeof textItems === 'string') {
    textContent = textItems.trim();
  }

  if (!textContent) {
    return res.status(400).json({ error: 'No text content provided' });
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Transfer-Encoding', 'chunked');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('X-Accel-Buffering', 'no');

  try {
    const stream = anthropic.messages.stream({
      model: 'claude-sonnet-4-5',
      max_tokens: 4096,
      system: [
        {
          type: 'text',
          text: buildSystemPrompt(),
          cache_control: { type: 'ephemeral' }, // cache stable system prompt (5 min TTL)
        },
      ],
      messages: [
        {
          role: 'user',
          content: `Analyse this marketing copy for compliance issues:\n\n${textContent}`,
        },
      ],
    });

    for await (const event of stream) {
      if (
        event.type === 'content_block_delta' &&
        event.delta.type === 'text_delta'
      ) {
        res.write(event.delta.text);
      }
    }
    res.end();
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.write(JSON.stringify({ error: err.message }));
      res.end();
    }
  }
});

const PORT = process.env.PORT ?? 3000;
app.listen(PORT, () => {
  console.log(`\n⚖️  Vetit → http://localhost:${PORT}\n`);
});
