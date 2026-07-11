#!/usr/bin/env node
/*
 * publish-blog.js — Standalone blog auto-poster for IB Math Revision.
 *
 * Origin: extracted from /functions/routes/twice-weekly-blog.js and
 * /functions/lib/buffer.js so we can run the blog pipeline outside
 * Firebase (specifically from a GitHub Actions cron).
 *
 * What it does:
 *   1. Picks a rotating blog topic from TOPIC_ROTATION.
 *   2. Calls Gemini 2.5 Flash to draft a ~700-word article + a short
 *      social caption.
 *   3. Pushes the caption to your Buffer Ideas board via the GraphQL
 *      createIdea mutation. You then open Buffer, review, and hit
 *      "Add to queue" to schedule it on Facebook / Instagram / X.
 *
 * What was intentionally dropped (vs the Firebase version):
 *   - Firestore write of the article body — this script is stateless.
 *     If you want the article live on ibmathrevision.com/blog, keep
 *     running the Firebase cron alongside; the Buffer push is the one
 *     that broke often and benefits from the redundancy.
 *   - LaTeX → PNG conversion (needs Puppeteer + Firebase Storage).
 *   - Owner email digest (needs Resend + owner list).
 *   - Budget guard (that's a Firestore lookup).
 *
 * Environment variables (all required):
 *   BUFFER_ACCESS_TOKEN   Buffer personal API key.
 *   BUFFER_ORG_ID         Buffer organization ID.
 *   GEMINI_API_KEY        Google AI Studio API key with Gemini access.
 *
 * Optional flags:
 *   --dry-run     Draft the article and print it, but do NOT hit Buffer.
 *   --topic=<i>   Force a specific topic index (0-based) instead of the
 *                 date-driven pick. Useful for testing.
 *
 * Exit codes:
 *   0  Success (published or dry-run completed).
 *   1  Missing/invalid environment.
 *   2  Gemini generation failed.
 *   3  Buffer push failed.
 *
 * Node 18+ is required for global fetch.
 */
"use strict";

// -----------------------------------------------------------------------------
// TOPIC ROTATION — kept verbatim from the Firebase version so the two
// pipelines stay in lockstep. If you edit one, edit the other.
// Update Buffer API types
// -----------------------------------------------------------------------------
const TOPIC_ROTATION = [
  // Product-line pillar posts (12 originals)
  { angle: "path-to-7-ladder",          course: "hlaa", label: "HL AA — the Path-to-7 mastery ladder explained (with example)", cta: "Try Path to 7 →", url: "/path-to-7.html" },
  { angle: "ai-marking-p2",             course: "slaa", label: "SL AA Paper 2 — how AI marking spots the method marks students miss", cta: "Try AI marking →", url: "/slaa.html" },
  { angle: "ia-feedback",               course: "hlai", label: "AI IA feedback — grade your Internal Assessment in 60 seconds", cta: "Grade my IA →", url: "/ia-feedback.html" },
  { angle: "hardest-questions",         course: "slai", label: "SL AI — the 5 hardest questions in Unit 3 (Financial Maths) and how to nail them", cta: "Practise Unit 3 →", url: "/slai.html" },
  { angle: "preib-diagnostic",          course: "preib", label: "PreIB Prep — the 30-minute diagnostic that predicts your DP1 grade", cta: "Try the diagnostic →", url: "/preib.html" },
  { angle: "sat-vs-ib-transferable",    course: "sat", label: "SAT Digital Math vs IB Maths — what transfers, what doesn't", cta: "See SAT Prep →", url: "/sat.html" },
  { angle: "predicted-papers",          course: "hlai", label: "How the Predicted Papers builder tailors a mock from your weakest topics", cta: "Try Predicted Papers →", url: "/predicted-papers.html" },
  { angle: "live-game-classroom",       course: "any", label: "Turning revision into a classroom game — the Live Game + Jeopardy setup", cta: "Play Live Game →", url: "/game.html" },
  { angle: "flashcards-spaced",         course: "any", label: "Spaced-repetition flashcards for IB Maths — the 6-day rhythm that works", cta: "Open flashcards →", url: "/flashcards.html" },
  { angle: "checklist-coverage",        course: "hlaa", label: "The syllabus checklist trick — spot the topics you thought you'd covered", cta: "Open checklist →", url: "/checklist.html" },
  { angle: "school-licences",           course: "school", label: "Whole-department IB Maths licences — what's included and what's not", cta: "See school pricing →", url: "/schools.html" },
  { angle: "referral-invite",           course: "any", label: "Invite a classmate, both get €10 off — how the referral works", cta: "Get your link →", url: "/referrals.html" },
  // SEO long-tail: paper- and technique-specific (10 new)
  { angle: "seo-slaa-paper1-differentiation", course: "slaa", label: "SL AA Paper 1 differentiation — 7 question types you must recognise", cta: "Practise differentiation →", url: "/slaa.html" },
  { angle: "seo-slaa-paper1-integration",     course: "slaa", label: "SL AA Paper 1 integration — the substitution patterns examiners test", cta: "Practise integration →", url: "/slaa.html" },
  { angle: "seo-hlaa-p3-investigation",       course: "hlaa", label: "HL AA Paper 3 — how to structure a 60-minute investigation for full marks", cta: "See HL AA questions →", url: "/hlaa.html" },
  { angle: "seo-hlai-p3-modelling",           course: "hlai", label: "HL AI Paper 3 — turning a real-world context into a model examiners reward", cta: "See HL AI questions →", url: "/hlai.html" },
  { angle: "seo-slai-financial-loans",        course: "slai", label: "SL AI compound interest & loans — CG50 keystrokes and common traps", cta: "Practise financial maths →", url: "/slai.html" },
  { angle: "seo-slai-chi-squared",            course: "slai", label: "SL AI chi-squared test — checklist for reaching the top marks", cta: "Practise statistics →", url: "/slai.html" },
  { angle: "seo-slaa-vectors",                course: "slaa", label: "SL AA vectors — the 4-step method for angle and dot-product questions", cta: "Practise vectors →", url: "/slaa.html" },
  { angle: "seo-hlaa-complex-numbers",        course: "hlaa", label: "HL AA complex numbers — moving between Cartesian, polar and Euler forms", cta: "Practise complex numbers →", url: "/hlaa.html" },
  { angle: "seo-hlai-voronoi",                course: "hlai", label: "HL AI Voronoi diagrams — the toolkit examiners want on your Paper 2", cta: "Practise Voronoi →", url: "/hlai.html" },
  { angle: "seo-hlaa-maclaurin",              course: "hlaa", label: "HL AA Maclaurin series — how to derive, apply and check your terms", cta: "Practise Maclaurin →", url: "/hlaa.html" },
  // IA-specific SEO (5 new — high commercial intent)
  { angle: "seo-ia-topic-ideas",        course: "any",  label: "IB Maths IA topic ideas — 20 that scored 18+/20 and why they worked", cta: "See IA support →", url: "/ia-support.html" },
  { angle: "seo-ia-criteria-c-d",       course: "any",  label: "IA criteria C and D — the difference between 'engaged' and 'critically reflective'", cta: "Try AI IA feedback →", url: "/ia-feedback.html" },
  { angle: "seo-ia-marking-scheme",     course: "any",  label: "Decoding the IB Maths IA mark scheme — what each descriptor actually means", cta: "Get examiner review →", url: "/subscribe.html?course=ia_examiner" },
  { angle: "seo-ia-word-count",         course: "any",  label: "IB Maths IA word count — the 6-12 page sweet spot that examiners prefer", cta: "See IA support →", url: "/ia-support.html" },
  { angle: "seo-ia-mistakes",           course: "any",  label: "10 IA mistakes that cost students 4+ marks — and how to avoid them", cta: "Try AI IA feedback →", url: "/ia-feedback.html" },
  // Exam technique / mindset (5 new — evergreen search demand)
  { angle: "seo-may-exam-plan",         course: "any",  label: "The 8-week IB Maths exam plan — what to revise, when, and for how long", cta: "See Path to 7 →", url: "/path-to-7.html" },
  { angle: "seo-gdc-keystrokes",        course: "any",  label: "GDC survival guide — the 15 keystrokes every IB Maths student should own", cta: "Practise with GDC →", url: "/" },
  { angle: "seo-p1-non-calc",           course: "any",  label: "Paper 1 non-calculator — how to survive without your GDC and still get 7", cta: "See predicted papers →", url: "/predicted-papers.html" },
  { angle: "seo-command-terms",         course: "any",  label: "IB Maths command terms — 'show', 'hence', 'find', 'justify' decoded", cta: "See flashcards →", url: "/flashcards.html" },
  { angle: "seo-formula-booklet",       course: "any",  label: "The IB Maths formula booklet — 10 formulas you should NOT rely on it for", cta: "See formula sheets →", url: "/formulas.html" },
  // High-search-volume long-tail (12 new)
  { angle: "seo-sine-vs-cosine-rule",   course: "any",  label: "Sine rule vs cosine rule — the 30-second decision tree that ends the confusion", cta: "Practise trigonometry →", url: "/slaa.html" },
  { angle: "seo-chain-rule-composite",  course: "any",  label: "The chain rule for composite functions — 3 patterns that unlock every question", cta: "Practise calculus →", url: "/slaa.html" },
  { angle: "seo-discriminant-roots",    course: "any",  label: "Discriminant and the nature of roots — the trap students fall into on Paper 1", cta: "Practise Paper 1 →", url: "/predicted-papers.html" },
  { angle: "seo-normal-distribution-gdc", course: "any", label: "Normal distribution on the CG50 and TI Nspire — every keystroke you need", cta: "Practise statistics →", url: "/slai.html" },
  { angle: "seo-optimisation-method",   course: "any",  label: "IB Maths optimisation — the 4-step method that lands every mark", cta: "Practise optimisation →", url: "/slaa.html" },
  { angle: "seo-grade-boundaries-2026", course: "any",  label: "May 2026 IB Maths grade boundaries — what to prepare for based on the last 5 years", cta: "See Path to 7 →", url: "/path-to-7.html" },
  { angle: "seo-ti-vs-casio",           course: "any",  label: "TI-Nspire vs Casio CG50 for IB Maths — which one saves you time in the exam", cta: "See our resources →", url: "/formulas.html" },
  { angle: "seo-integration-by-parts",  course: "hlaa", label: "Integration by parts — the LIATE rule and why cyclic integrals trip up HL students", cta: "Practise HL calculus →", url: "/hlaa.html" },
  { angle: "seo-ia-cooling",            course: "any",  label: "Newton's Law of Cooling as an IA — how to score 18+/20 (with worked example)", cta: "See IA support →", url: "/ia-support.html" },
  { angle: "seo-ia-sports-analytics",   course: "any",  label: "Sports analytics IA — using regression to answer 'do NBA salaries predict wins?'", cta: "Try AI IA feedback →", url: "/ia-feedback.html" },
  { angle: "seo-p1-time-management",    course: "any",  label: "Paper 1 time management — the 2-minute exam scan that saves 8+ marks", cta: "Practise Paper 1 →", url: "/predicted-papers.html" },
  { angle: "seo-p3-investigation-frame", course: "hlaa", label: "The 5-part frame for a Paper 3 investigation — how examiners want you to structure it", cta: "See HL AA questions →", url: "/hlaa.html" },
];

const BASE_URL = "https://ibmathrevision.com";

// -----------------------------------------------------------------------------
// CLI arg parsing (deliberately dependency-free).
// -----------------------------------------------------------------------------
const argv = process.argv.slice(2);
const args = { dryRun: false, topicIdx: null };
for (const a of argv) {
  if (a === "--dry-run") args.dryRun = true;
  else if (a.startsWith("--topic=")) args.topicIdx = parseInt(a.slice(8), 10);
}

// -----------------------------------------------------------------------------
// Topic picker: date-driven so Mon and Thu never collide, and the schedule
// cycles through every angle in TOPIC_ROTATION over ~15 weeks.
// -----------------------------------------------------------------------------
function weekIndex(date = new Date()) {
  const start = Date.UTC(2026, 0, 5); // Mon 5 Jan 2026
  return Math.max(0, Math.floor((date.getTime() - start) / (7 * 24 * 3600 * 1000)));
}
function pickTopic() {
  if (args.topicIdx !== null && !Number.isNaN(args.topicIdx)) {
    const t = TOPIC_ROTATION[((args.topicIdx % TOPIC_ROTATION.length) + TOPIC_ROTATION.length) % TOPIC_ROTATION.length];
    console.log(`[publish-blog] forced topic idx=${args.topicIdx} → ${t.angle}`);
    return t;
  }
  const now = new Date();
  const w = weekIndex(now);
  const isThursday = now.getUTCDay() === 4;
  const idx = ((w * 2) + (isThursday ? 1 : 0)) % TOPIC_ROTATION.length;
  return TOPIC_ROTATION[idx];
}
function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

// -----------------------------------------------------------------------------
// Gemini article generator — direct fetch to the public REST API. No SDK
// dependency so `npm ci` in the GitHub Action stays a no-op.
// -----------------------------------------------------------------------------
async function generateArticle(apiKey, topic) {
  const model = process.env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const prompt = [
    `You are Pete Bromfield, an IB Maths teacher and the founder of ibmathrevision.com.`,
    `Write a punchy, teacher-voiced blog post (600-850 words) on this angle:`,
    ``,
    `TITLE HINT: ${topic.label}`,
    `AUDIENCE: IB DP students, parents, and DP Maths teachers.`,
    `PRODUCT TO WEAVE IN (naturally, not in a salesy way): ${topic.url}`,
    ``,
    `Return ONLY valid JSON, no markdown fence:`,
    `{`,
    `  "title": "<60-90 chars, no clickbait>",`,
    `  "subtitle": "<one-line hook, 100-150 chars>",`,
    `  "html": "<article HTML using <p>, <h2>, <h3>, <ul>, <ol>, <blockquote>, <a> — no <html><body> wrappers. Include 3-4 subheadings.>",`,
    `  "socialCaption": "<180-220 char caption for Facebook/Instagram/X — plain text, includes 2-3 relevant hashtags at the end>",`,
    `  "callToAction": "${topic.cta}",`,
    `  "callToActionUrl": "${topic.url}"`,
    `}`,
    ``,
    `Rules:`,
    `- Write in first person occasionally.`,
    `- Include one concrete example or vignette.`,
    `- Never invent statistics, pass rates, or student counts.`,
    `- Never use unhedged absolutes ("guaranteed", "proven", "the only", "always").`,
    `- Do not claim awards, endorsements, or school partnerships.`,
    `- The four DP maths courses (SL AI, SL AA, HL AI, HL AA) began Aug 2019, first exams May 2021.`,
    `- End the article HTML with a compact CTA paragraph linking to ${topic.url}.`,
    `- The socialCaption must NOT contain markdown or HTML.`,
    `- Wrap any math in LaTeX delimiters: $…$ inline, $$…$$ display. Plain ASCII only elsewhere.`,
  ].join("\n");

  const body = {
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.75,
      maxOutputTokens: 2400,
      topP: 0.9,
      // 2.5 Flash: thinking OFF to keep the response snappy and predictable.
      thinkingConfig: { thinkingBudget: 0 },
    },
    safetySettings: [
      { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
      { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
    ],
  };

  // Simple 1-retry ladder — Gemini flash occasionally 503s on cold starts.
  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`Gemini API HTTP ${res.status}: ${errText.slice(0, 400)}`);
      }
      const json = await res.json();
      const text = json?.candidates?.[0]?.content?.parts?.map((p) => p.text).filter(Boolean).join("").trim();
      if (!text) throw new Error("Gemini returned no text.");
      const s = text.indexOf("{");
      const e = text.lastIndexOf("}");
      if (s < 0 || e < 0) throw new Error("Gemini response contained no JSON object.");
      return JSON.parse(text.slice(s, e + 1));
    } catch (e) {
      lastErr = e;
      console.warn(`[publish-blog] Gemini attempt ${attempt} failed: ${e.message}`);
      if (attempt < 2) await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw lastErr;
}

// -----------------------------------------------------------------------------
// Buffer GraphQL client — copied verbatim from /functions/lib/buffer.js so
// this file is fully self-contained. If Buffer's schema changes, update
// BOTH files in the same commit.
// -----------------------------------------------------------------------------
const BUFFER_GRAPHQL_URL = "https://api.buffer.com";

async function bufferGraphQL({ token, query, variables }) {
  const res = await fetch(BUFFER_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`Buffer GraphQL HTTP ${res.status}: ${JSON.stringify(json).slice(0, 400)}`);
  }
  if (json.errors && json.errors.length) {
    throw new Error(`Buffer GraphQL error: ${json.errors.map((e) => e.message).join("; ").slice(0, 400)}`);
  }
  return json.data;
}

function gqlString(s) {
  return String(s || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

async function verifyBufferAuth({ token }) {
  try {
    await bufferGraphQL({ token, query: `{ __typename }` });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

async function createIdea({ token, organizationId, title, text }) {
  const query = `
    mutation {
      createIdea(input: {
        organizationId: "${gqlString(organizationId)}",
        content: {
          title: "${gqlString(title)}",
          text: "${gqlString(text)}"
        }
      }) {
        ... on Idea { id content { title text } }
        ... on BasicError { message }
      }
    }
  `;
  const data = await bufferGraphQL({ token, query });
  const idea = data && data.createIdea;
  if (!idea) throw new Error("Buffer createIdea returned no data.");
  if (idea.message && !idea.id) throw new Error(`Buffer createIdea rejected: ${idea.message}`);
  return {
    id: idea.id,
    title: idea.content && idea.content.title,
    text:  idea.content && idea.content.text,
  };
}

// -----------------------------------------------------------------------------
// Entry point.
// -----------------------------------------------------------------------------
async function main() {
  const { BUFFER_ACCESS_TOKEN, BUFFER_ORG_ID, GEMINI_API_KEY } = process.env;

  if (!GEMINI_API_KEY) {
    console.error("[publish-blog] FATAL — GEMINI_API_KEY env var is not set.");
    process.exit(1);
  }
  if (!args.dryRun) {
    if (!BUFFER_ACCESS_TOKEN) {
      console.error("[publish-blog] FATAL — BUFFER_ACCESS_TOKEN env var is not set (use --dry-run to skip Buffer).");
      process.exit(1);
    }
    if (!BUFFER_ORG_ID) {
      console.error("[publish-blog] FATAL — BUFFER_ORG_ID env var is not set (use --dry-run to skip Buffer).");
      process.exit(1);
    }
  }

  const topic = pickTopic();
  console.log(`[publish-blog] topic angle=${topic.angle} label="${topic.label}"`);

  let article;
  try {
    article = await generateArticle(GEMINI_API_KEY, topic);
  } catch (e) {
    console.error(`[publish-blog] Gemini generation failed after retries: ${e.message}`);
    process.exit(2);
  }

  const slug = slugify(article.title);
  const articleId = `blog-${weekIndex()}-${slug}`.slice(0, 100);
  const articleUrl = `${BASE_URL}/blog.html?id=${articleId}`;

  console.log(`[publish-blog] title: ${article.title}`);
  console.log(`[publish-blog] subtitle: ${article.subtitle}`);
  console.log(`[publish-blog] articleUrl: ${articleUrl}`);
  console.log(`[publish-blog] socialCaption: ${article.socialCaption}`);
  console.log(`[publish-blog] html length: ${(article.html || "").length} chars`);

  if (args.dryRun) {
    console.log("[publish-blog] DRY RUN — Buffer push skipped. Exiting 0.");
    return;
  }

  // Verify token before firing createIdea (cheap introspection query).
  const auth = await verifyBufferAuth({ token: BUFFER_ACCESS_TOKEN });
  if (!auth.ok) {
    console.error(`[publish-blog] Buffer auth probe failed: ${auth.error}`);
    process.exit(3);
  }
  console.log("[publish-blog] Buffer auth OK.");

  const dateStamp = new Date().toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  const ideaTitle = `Blog · ${dateStamp} · ${article.title.slice(0, 60)}`;
  const ideaText  = `${article.socialCaption}\n\nRead: ${articleUrl}`;

  try {
    const idea = await createIdea({
      token: BUFFER_ACCESS_TOKEN,
      organizationId: BUFFER_ORG_ID,
      title: ideaTitle,
      text: ideaText,
    });
    console.log(`[publish-blog] Buffer idea created: id=${idea.id} title="${idea.title}"`);
  } catch (e) {
    console.error(`[publish-blog] createIdea failed: ${e.message}`);
    process.exit(3);
  }

  console.log("[publish-blog] Done ✓");
}

main().catch((e) => {
  console.error("[publish-blog] Unhandled error:", e);
  process.exit(1);
});
