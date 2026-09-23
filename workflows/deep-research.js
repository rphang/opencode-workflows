export const meta = {
  name: 'deep-research',
  description: 'Research a question across several angles on the web, cross-check every claim with independent skeptics, and return a cited Markdown report',
  whenToUse: 'A question that needs many web sources read and cross-checked, e.g. /deep-research What changed in the Node.js permission model between v20 and v22? Requires working websearch/webfetch tools: run one websearch in your own session first (opencode asks you to pick a web search provider once, and workflow agents cannot answer that prompt).',
  phases: [
    { title: 'Plan', detail: 'split the question into independent research angles' },
    { title: 'Research', detail: 'one web researcher per angle (websearch + webfetch)' },
    { title: 'Extract', detail: 'turn each angle\'s notes into atomic claims with sources' },
    { title: 'Verify', detail: '3 skeptics per claim try to refute it; majority vote' },
    { title: 'Synthesize', detail: 'write the cited report from the surviving claims' },
  ],
}

// ---------------------------------------------------------------------------------------------
// Input: args is the question (string), or { question }.
// ---------------------------------------------------------------------------------------------
const question = typeof args === 'string' ? args.trim() : (args && typeof args.question === 'string' ? args.question.trim() : '')
if (!question) {
  throw new Error('deep-research needs a question: pass it as args, e.g. /deep-research What changed in X between v1 and v2?')
}

const MIN_ANGLES = 3
const MAX_ANGLES = 6
const MAX_CLAIMS_PER_ANGLE = 8
const MAX_CLAIMS_TOTAL = 40
const SKEPTICS = 3
const MAJORITY = Math.floor(SKEPTICS / 2) + 1
// A researcher whose web tools are missing or failing replies with exactly this, instead of writing notes from memory.
const NO_WEB = 'NO_WEB_ACCESS'
const noWeb = (notes) => typeof notes === 'string' && notes.trim().startsWith(NO_WEB)

const ANGLES_SCHEMA = {
  type: 'object',
  required: ['angles'],
  properties: {
    angles: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        required: ['title', 'query'],
        properties: {
          title: { type: 'string', description: 'short label for this angle' },
          query: { type: 'string', description: 'what to search for / investigate' },
          rationale: { type: 'string' },
        },
      },
    },
  },
}

const CLAIMS_SCHEMA = {
  type: 'object',
  required: ['claims'],
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        required: ['claim', 'sources'],
        properties: {
          claim: { type: 'string', description: 'one atomic, checkable factual statement' },
          sources: {
            type: 'array',
            items: {
              type: 'object',
              required: ['url'],
              properties: { url: { type: 'string' }, title: { type: 'string' } },
            },
          },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['refuted', 'couldNotCheck', 'reasoning'],
  properties: {
    refuted: { type: 'boolean', description: 'true only if you found evidence that the claim is false, unsupported by its sources, outdated, or misleading' },
    couldNotCheck: { type: 'boolean', description: 'true if websearch/webfetch were missing or failed, so you could not check the claim at all; the vote then counts as an abstention' },
    reasoning: { type: 'string' },
    counterSource: { type: 'string', description: 'URL of the evidence that refutes it, if any' },
  },
}

// ---------------------------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------------------------
phase('Plan')
const plan = await agent(
  `You are planning web research for this question:\n\n${question}\n\n` +
    `Split it into ${MIN_ANGLES}-${MAX_ANGLES} independent research angles that together cover it ` +
    '(e.g. primary/official sources, changelogs and release notes, issue trackers and discussions, ' +
    'expert analysis, counter-evidence and criticism). Each angle gets its own researcher, so make ' +
    'them non-overlapping. Do not research yet — only plan.',
  { label: 'Plan angles', schema: ANGLES_SCHEMA },
)

let angles = plan && Array.isArray(plan.angles) ? plan.angles.filter((a) => a && a.title && a.query) : []
if (angles.length === 0) {
  log('Planner returned no angles; researching the question directly')
  angles = [{ title: 'Direct', query: question }]
}
if (angles.length > MAX_ANGLES) {
  log(`Planner proposed ${angles.length} angles; keeping the first ${MAX_ANGLES}, dropped: ${angles.slice(MAX_ANGLES).map((a) => a.title).join(', ')}`)
  angles = angles.slice(0, MAX_ANGLES)
}
log(`Researching ${angles.length} angles: ${angles.map((a) => a.title).join(' | ')}`)

// ---------------------------------------------------------------------------------------------
// Research → Extract, per angle, no barrier between the two stages
// ---------------------------------------------------------------------------------------------
phase('Research')
const perAngle = await pipeline(
  angles,
  (angle) =>
    agent(
      `Research one angle of a larger question using your websearch and webfetch tools.\n\n` +
        `Overall question: ${question}\nYour angle: ${angle.title}\nFocus: ${angle.query}\n\n` +
        'Run several searches, then fetch and actually read the most relevant pages (prefer primary ' +
        'and official sources, recent material, and sources that disagree with each other). ' +
        'Return research notes: every factual finding on its own line followed by the exact URL it ' +
        'came from. Quote precise figures, versions and dates. Note contradictions between sources. ' +
        'Do not write a polished answer — the notes are the product. ' +
        `If websearch or webfetch is unavailable or fails (e.g. "Web search cancelled"), reply with exactly ${NO_WEB} and nothing else; never write notes from memory.`,
      { label: `Research: ${angle.title}`, phase: 'Research' },
    ),
  (notes, angle) => {
    if (!notes) return null
    if (noWeb(notes)) return { noWebAccess: true }
    return agent(
      `Extract atomic factual claims from these research notes on the angle "${angle.title}" ` +
        `of the question: ${question}\n\n--- NOTES ---\n${notes}\n--- END NOTES ---\n\n` +
        `Return at most ${MAX_CLAIMS_PER_ANGLE} claims that matter most for the question. Each claim must be ` +
        'a single checkable statement, attributed to the source URL(s) in the notes that support it. ' +
        'Drop anything the notes give no source for. Do not add knowledge that is not in the notes.',
      { label: `Extract: ${angle.title}`, phase: 'Extract', schema: CLAIMS_SCHEMA },
    )
  },
)

const blind = perAngle.filter((r) => r && r.noWebAccess).length
if (blind >= Math.ceil(angles.length / 2)) {
  log(`${blind} of ${angles.length} researchers had no working web search; stopping before extraction and verification`)
  return `# ${question}

No web access: ${blind} of ${angles.length} researchers could not use websearch/webfetch, so nothing was researched or verified. ` +
    'Make sure web search works in your own opencode session first: run one websearch there (opencode asks you to choose a web search provider the first time, and workflow agents cannot answer that prompt), then run /deep-research again.'
}
const researched = perAngle.filter((r) => r && !r.noWebAccess)
if (blind) log(`${blind} researcher(s) had no working web search; their angles are skipped`)
const failedAngles = angles.filter((_, i) => !perAngle[i]).map((a) => a.title)
if (failedAngles.length) log(`No results for ${failedAngles.length} angle(s): ${failedAngles.join(', ')}`)
if (researched.length === 0) {
  return `# ${question}\n\nNo research results: every research agent failed or was stopped (is the websearch tool available?). Nothing could be verified.`
}

// Barrier justified: dedupe claims across ALL angles before the expensive verification fan-out.
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim()
const byKey = new Map()
for (let i = 0; i < perAngle.length; i++) {
  const r = perAngle[i]
  if (!r || !Array.isArray(r.claims)) continue
  for (const c of r.claims.slice(0, MAX_CLAIMS_PER_ANGLE)) {
    if (!c || typeof c.claim !== 'string' || !c.claim.trim()) continue
    const key = norm(c.claim)
    const sources = Array.isArray(c.sources) ? c.sources.filter((s) => s && typeof s.url === 'string') : []
    const existing = byKey.get(key)
    if (existing) {
      for (const s of sources) if (!existing.sources.some((x) => x.url === s.url)) existing.sources.push(s)
      if (!existing.angles.includes(angles[i].title)) existing.angles.push(angles[i].title)
    } else {
      byKey.set(key, { claim: c.claim.trim(), sources: sources.slice(), confidence: c.confidence || 'medium', angles: [angles[i].title] })
    }
  }
}
let claims = [...byKey.values()]
if (claims.length > MAX_CLAIMS_TOTAL) {
  log(`${claims.length} distinct claims; verifying the first ${MAX_CLAIMS_TOTAL}, ${claims.length - MAX_CLAIMS_TOTAL} dropped unverified`)
  claims = claims.slice(0, MAX_CLAIMS_TOTAL)
}
log(`${claims.length} distinct claims to cross-check with ${SKEPTICS} skeptics each`)

// ---------------------------------------------------------------------------------------------
// Verify: adversarial majority vote per claim. Errored verifiers do not count as refutations.
// ---------------------------------------------------------------------------------------------
const LENSES = [
  'Check whether the cited sources actually say this (misquotes, overreach, wrong numbers).',
  'Look for newer or contradicting information that makes the claim outdated or false.',
  'Look for independent corroboration; a claim only one weak source makes is not established.',
]

phase('Verify')
const verdicts = await parallel(
  claims.map((c, ci) => async () => {
    const votes = await parallel(
      Array.from({ length: SKEPTICS }, (_, k) => () =>
        agent(
          `You are a skeptical fact-checker. Try to REFUTE this claim, made while researching "${question}":\n\n` +
            `CLAIM: ${c.claim}\nCITED SOURCES: ${c.sources.map((s) => s.url).join(', ') || '(none)'}\n\n` +
            `${LENSES[k % LENSES.length]} Use websearch and webfetch to check. ` +
            'Set refuted=true if what you found shows the claim is false, not supported by its sources, outdated, or misleading, ' +
            'including when your searches worked but found no support for it. ' +
            'If websearch/webfetch are missing or fail so you cannot check the claim at all, set couldNotCheck=true and refuted=false: ' +
            'a tool failure is never a refutation. Otherwise set couldNotCheck=false.',
          { label: `Verify #${ci + 1}.${k + 1}`, phase: 'Verify', schema: VERDICT_SCHEMA },
        ),
      ),
    )
    // Errored skeptics (null) and those that could not check abstain.
    const cast = votes.filter((v) => v && v.couldNotCheck !== true)
    const refutes = cast.filter((v) => v.refuted === true).length
    const supports = cast.filter((v) => v.refuted === false).length
    let status = 'unverified'
    if (refutes >= MAJORITY) status = 'refuted'
    else if (supports >= MAJORITY) status = 'verified'
    return { ...c, status, refutes, supports, errored: SKEPTICS - cast.length }
  }),
)

const judged = verdicts.filter(Boolean)
const verified = judged.filter((c) => c.status === 'verified')
const unverified = judged.filter((c) => c.status === 'unverified')
const refuted = judged.filter((c) => c.status === 'refuted')
// A claim whose whole verification task failed is unverified, not refuted.
for (let i = 0; i < verdicts.length; i++) {
  if (!verdicts[i]) unverified.push({ ...claims[i], status: 'unverified', refutes: 0, supports: 0, errored: SKEPTICS })
}
log(`Cross-check: ${verified.length} verified, ${refuted.length} refuted (dropped), ${unverified.length} unverified`)

// ---------------------------------------------------------------------------------------------
// Synthesize
// ---------------------------------------------------------------------------------------------
phase('Synthesize')
const fmt = (list, offset) =>
  list
    .map((c, i) => `[C${offset + i + 1}] ${c.claim}\n    sources: ${c.sources.map((s) => (s.title ? `${s.title} <${s.url}>` : s.url)).join('; ') || '(none)'}\n    votes: ${c.supports} support / ${c.refutes} refute${c.errored ? ` / ${c.errored} could not check (error or no web access)` : ''}`)
    .join('\n') || '(none)'

const report = await agent(
  `Write the final research report answering this question:\n\n${question}\n\n` +
    `VERIFIED CLAIMS (each survived an adversarial cross-check by ${SKEPTICS} independent skeptics):\n${fmt(verified, 0)}\n\n` +
    `UNVERIFIED CLAIMS (the verifiers could not check these because of errors, rate limits or failing web tools; they were NOT refuted):\n${fmt(unverified, verified.length)}\n\n` +
    `${refuted.length} other claim(s) were refuted by a majority of skeptics and have been removed; do not reintroduce them.\n\n` +
    'Write GitHub-flavored Markdown: a title, a short direct answer first, then sections that organize the findings, ' +
    'then a numbered "Sources" list. Base the report ONLY on the claims above. Cite every factual sentence with ' +
    'numbered references like [1] that map to the Sources list (use the URLs given). Put claims from the second list ' +
    'in a separate "Unverified" section, clearly marked as not cross-checked. Call out disagreements between sources ' +
    'and gaps the research could not answer. Return only the Markdown report.',
  { label: 'Report', phase: 'Synthesize' },
)

if (typeof report === 'string' && report.trim()) return report

// Fallback when the writer failed: a plain cited listing, still useful.
const lines = [`# ${question}`, '', '_The report writer failed; listing the cross-checked claims directly._', '']
lines.push('## Verified claims', '')
for (const c of verified) lines.push(`- ${c.claim} (${c.sources.map((s) => s.url).join(', ')})`)
if (unverified.length) {
  lines.push('', '## Unverified claims (could not be cross-checked; not refuted)', '')
  for (const c of unverified) lines.push(`- ${c.claim} (${c.sources.map((s) => s.url).join(', ')})`)
}
return lines.join('\n')
