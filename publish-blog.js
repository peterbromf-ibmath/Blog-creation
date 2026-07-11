#!/usr/bin/env node
'use strict';

const TOPIC_ROTATION = [
  { angle: 'path-to-7-ladder',       course: 'hlaa',   label: 'HL AA — the Path-to-7 mastery ladder explained (with example)', cta: 'Try Path to 7 →',      url: '/path-to-7.html' },
  { angle: 'ai-marking-p2',          course: 'slaa',   label: 'SL AA Paper 2 — how AI marking spots the method marks students miss', cta: 'Try AI marking →', url: '/slaa.html' },
  { angle: 'ia-feedback',            course: 'hlai',   label: 'AI IA feedback — grade your Internal Assessment in 60 seconds', cta: 'Grade my IA →',       url: '/ia-feedback.html' },
  { angle: 'hardest-questions',      course: 'slai',   label: 'SL AI — the 5 hardest questions in Unit 3 (Financial Maths) and how to nail them', cta: 'Practise Unit 3 →', url: '/slai.html' },
  { angle: 'preib-diagnostic',       course: 'preib',  label: 'PreIB Prep — the 30-minute diagnostic that predicts your DP1 grade', cta: 'Try the diagnostic →', url: '/preib.html' },
  { angle: 'sat-vs-ib-transferable', course: 'sat',    label: 'SAT Digital Math vs IB Maths — what transfers, what doesn\'t', cta: 'See SAT Prep →',       url: '/sat.html' },
  { angle: 'predicted-papers',       course: 'hlai',   label: 'How the Predicted Papers builder tailors a mock from your weakest topics', cta: 'Try Predicted Papers →', url: '/predicted-papers.html' },
  { angle: 'live-game-classroom',    course: 'any',    label: 'Turning revision into a classroom game — the Live Game + Jeopardy setup', cta: 'Play Live Game →', url: '/game.html' },
  { angle: 'flashcards-spaced',      course: 'any',    label: 'Spaced-repetition flashcards for IB Maths — the 6-day rhythm that works', cta: 'Open flashcards →', url: '/flashcards.html' },
  { angle: 'checklist-coverage',     course: 'hlaa',   label: 'The syllabus checklist trick — spot the topics you thought you\'d covered', cta: 'Open checklist →', url: '/checklist.html' },
  { angle: 'school-licences',        course: 'school', label: 'Whole-department IB Maths licences — what\'s included and what\'s not', cta: 'See school pricing →', url: '/schools.html' },
  { angle: 'referral-invite',        course: 'any',    label: 'Invite a classmate, both get €10 off — how the referral works', cta: 'Get your link →',      url: '/referrals.html' }
];

const BASE_URL = 'https://ibmathrevision.com';

const argv = process.argv.slice(2);
const args = { dryRun: false, topicIdx: null };
for (const a of argv) {
  if (a === '--dry-run') args.dryRun = true;
  else if (a.startsWith('--topic=')) args.topicIdx = parseInt(a.slice(8), 10);
}

function weekIndex(date = new Date()) {
  const start = Date.UTC(2026, 0, 5);
  return Math.max(0, Math.floor((date.getTime() - start) / (7 * 24 * 3600 * 1000)));
}

function pickTopic() {
  if (args.topicIdx !== null && !Number.isNaN(args.topicIdx)) {
    return TOPIC_ROTATION[((args.topicIdx % TOPIC_ROTATION.length) + TOPIC_ROTATION.length) % TOPIC_ROTATION.length];
  }
  const now = new Date();
  const w = weekIndex(now);
  const isThursday = now.getUTCDay() === 4;
  const idx = ((w * 2) + (isThursday ? 1 : 0)) % TOPIC_ROTATION.length;
  return TOPIC_ROTATION[idx];
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

async function generateArticle(apiKey, topic) {
const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${encodeURIComponent(apiKey)}`; 
  const prompt = `You are Pete Bromfield, an IB Maths teacher. Write a punchy blog post (600 words) on: ${topic.label}. Return valid JSON: { "title": "...", "subtitle": "...", "socialCaption": "..." }`;
  const body = { contents: [{ role: 'user', parts: [{ text: prompt }] }] };
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const json = await res.json();
      const text = json?.candidates?.[0]?.content?.parts?.[0]?.text || ""; if (!text) { console.error("Gemini Error Response:", JSON.stringify(json)); throw new Error("Gemini returned no text. Check your API key or usage limits."); } 
      const s = text.indexOf('{'); 
      const e = text.lastIndexOf('}'); return JSON.parse(text.slice(s, e + 1)); 
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function bufferGraphQL({ token, query }) {
  const res = await fetch('https://api.buffer.com', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query })
  });
  const json = await res.json();
  if (json.errors) throw new Error(json.errors[0].message);
  return json.data;
}

function gqlString(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

async function createDraft({ token, profileId, text }) {
  const query = `mutation { createDraft(input: { profileId: "${gqlString(profileId)}", content: { text: "${gqlString(text)}" } }) { draft { id } } }`;
  const data = await bufferGraphQL({ token, query });
  return { id: data.createDraft.draft.id };
}

async function main() {
  const { BUFFER_ACCESS_TOKEN, BUFFER_PROFILE_ID, GEMINI_API_KEY } = process.env;
  if (!GEMINI_API_KEY || !BUFFER_ACCESS_TOKEN || !BUFFER_PROFILE_ID) {
    console.error('Missing env vars.');
    process.exit(1);
  }
  const topic = pickTopic();
  const article = await generateArticle(GEMINI_API_KEY, topic);
  const articleUrl = `${BASE_URL}/blog.html?id=blog-${weekIndex()}-${slugify(article.title)}`;
  const draftText = `${article.socialCaption}\n\nRead more: ${articleUrl}`;
  try {
    const draft = await createDraft({ token: BUFFER_ACCESS_TOKEN, profileId: BUFFER_PROFILE_ID, text: draftText });
    console.log(`[publish-blog] Done. Draft created: ${draft.id}`);
  } catch (e) {
    console.error('Buffer draft failed:', e.message);
    process.exit(3);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
