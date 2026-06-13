# AI News Facebook Routine: Scoring Rubric and Editorial Guardrails

## Purpose

This rubric governs how The Lens AI and Automation selects, writes, verifies, and approves AI news content for Facebook. It is designed to keep daily publishing velocity high without weakening evidence standards, editorial independence, or auditability.

The routine must optimize for trustworthy, platform ready journalism. It must not optimize for reach by relaxing verification or inflating claims.

## Editorial Decision Rule

Each day, the routine should review candidate stories and publish only the highest scoring story that passes every hard gate below.

If no candidate passes the hard gates, the routine must not publish. It should instead return `no publishable story` with the failed gate reasons.

## Hard Gates

Any story fails immediately if any of the following is true:

1. There is no primary source for the core claim.
2. A material claim depends on rumor, anonymous sourcing, or aggregator recycling.
3. The Fact Checker verdict is anything other than `verified`.
4. The draft is under 600 words.
5. The audience facing copy uses em dashes, en dashes, or dash separators.
6. The draft does not end with an engagement question or direct discussion prompt.
7. A referenced demo, launch stream, keynote, interview, or video clip lacks a source link.
8. The image plan is missing, or it uses AI generated imagery without documented failed attempts to source a real image first.
9. The story includes unverified quotes, metrics, dates, funding figures, customer names, product details, or regulatory facts.
10. The story would materially affect markets, policy, or reputation, and the sourcing is not strong enough to withstand scrutiny.

## Weighted Story Scoring

Only stories that pass the hard gates should be scored. Maximum score is 100.

### 1. Relevance to the audience, 20 points

- 0 to 5: niche update with limited practical value
- 6 to 10: useful to a narrow AI or ops audience
- 11 to 15: broadly relevant to AI builders, operators, or business leaders
- 16 to 20: directly matters to a wide audience following AI products, automation, labor, regulation, or market structure

### 2. Real world impact, 20 points

- 0 to 5: incremental or cosmetic change
- 6 to 10: meaningful but bounded product or company update
- 11 to 15: likely to change user behavior, spending, workflows, or competition
- 16 to 20: meaningfully shifts the market, policy environment, or operating assumptions

### 3. Novelty and timeliness, 15 points

- 0 to 5: stale or heavily recycled angle
- 6 to 10: current story with a moderately fresh angle
- 11 to 15: genuinely new development or an unusually strong new framing of a live story

### 4. Evidence quality, 20 points

- 0 to 5: thin sourcing, low confidence
- 6 to 10: one solid primary source but limited support
- 11 to 15: multiple strong primary sources or one primary plus high quality corroboration
- 16 to 20: primary source package is robust, claims are traceable, and fact checking should be straightforward

### 5. Facebook fit, 10 points

- 0 to 3: important but poorly suited to Facebook discussion
- 4 to 6: understandable with some effort
- 7 to 8: clear, accessible, and likely to stop the scroll
- 9 to 10: strong hook, plain language, and easy for a general audience to discuss

### 6. Conversation potential, 10 points

- 0 to 3: little room for informed discussion
- 4 to 6: some likely engagement
- 7 to 8: clear tradeoffs, implications, or disagreements readers will want to discuss
- 9 to 10: unusually strong discussion potential without relying on outrage or distortion

### 7. Asset readiness, 5 points

- 0 to 1: no credible image path, weak support materials
- 2 to 3: usable assets exist but need work
- 4 to 5: real image path is available and any video references are already linked

## Publishing Thresholds

- 80 to 100: publish candidate, assuming it remains the top scoring cleared story
- 70 to 79: publish only if the news cycle is thin and the thesis is still strong
- Below 70: do not publish as the lead Facebook story

Tie breaker order:

1. Higher evidence quality
2. Higher real world impact
3. Higher conversation potential
4. Better real image path

## Required Research Brief Fields

The Content Researcher must provide these fields for every candidate:

1. Headline candidate
2. One sentence thesis
3. Why it matters
4. Primary sources with links
5. Secondary sources, if used
6. Material claims list
7. Score breakdown by rubric category
8. Risk flags, including rumor risk, legal risk, policy risk, and market sensitivity
9. Real image options with source links
10. Relevant video or demo links, if applicable
11. Recommendation: publish, hold, or reject

## Draft Requirements

The Editorial Writer must produce copy that meets all of the following:

1. Minimum 600 words
2. Clear source backed thesis in the opening section
3. Plain language suitable for Facebook readers without diluting the facts
4. No em dashes, no en dashes, and no dash separators
5. No fabricated detail, invented color, or unsupported interpretation stated as fact
6. A closing engagement question or direct prompt for discussion

## Facebook Copy Guardrails

These rules are Facebook specific for v1. Do not add LinkedIn conventions, cross platform reuse notes, or channel neutral filler.

### Tone

- Clear, direct, and informed
- Conversational enough for Facebook, but never breathless, snarky, or hype driven
- Analytical rather than promotional
- Confident only where the sourcing is strong

### Hook Rules

- Open with one strong factual hook in the first two sentences
- The hook must name the company, product, research group, regulator, or executive at the center of the story
- The hook must state what changed and why it matters
- Do not open with generic throat clearing such as "Big news in AI today"
- Do not open with a question unless the answer is immediately grounded in verified facts
- Do not tease unsupported implications just to increase curiosity

### Length and Structure Target

- Final Facebook post body target: 600 to 900 words
- Aim for short paragraphs, usually one to three sentences
- Put the core thesis high in the post
- Move supporting detail, caveats, and evidence after the main news value is established
- End with a discussion prompt that invites informed reader response

### Hashtag Policy

- Default to no hashtags
- Use at most two hashtags when they add clear retrieval value
- Allowed hashtags should be plain and specific, for example `#AI` or `#Automation`
- Do not use engagement bait, trend stuffing, branded campaign tags, or decorative hashtag clusters

### Banned Formatting and Punctuation Patterns

- No em dashes
- No en dashes
- No dash separators used as stylistic breaks
- No all caps emphasis except official product names or acronyms
- No excessive exclamation marks
- No bullet spam in audience facing copy unless the format is explicitly list based for clarity
- No unsupported scare quotes or insinuating punctuation

### Required Attribution Language

- Material claims must be attributed in copy when the source is not obvious from the sentence alone
- Preferred attribution patterns:
  - `According to [primary source], ...`
  - `[Company] said in its official blog post that ...`
  - `In the research paper, the authors report ...`
  - `On the earnings call, [executive name] said ...`
- If a claim remains uncertain but still publishable as context, label it plainly with wording such as `the company has not yet disclosed`, `the available filing does not specify`, or `the evidence so far suggests`
- Never present secondary reporting as if it were a primary source

## Fallback When Article Fetch Fails

If the article scrape fails and only a verified upstream research summary is available, the routine may still draft Facebook copy only under these conditions:

1. The research summary itself traces every material claim to linked primary sources
2. The Fact Checker verifies the claims against those primary sources, not against the summary alone
3. The copy explicitly avoids implying that the full article text was reviewed when it was not
4. Any missing detail from the failed scrape is omitted rather than inferred

When operating in this fallback mode:

- Base the story on the verified research brief and cited source documents only
- Attribute the reporting path conservatively, for example `Based on the company's announcement and supporting documents reviewed by The Lens`
- Do not reference article specific framing, wording, or quotes unless they were independently recovered from a primary source
- If the failed scrape removes important context that materially weakens confidence, do not publish

## Non Fabrication and Uncertainty Rules

- Never invent quotes, paraphrases, numbers, timelines, customer examples, product behavior, legal implications, or motives
- Never infer availability, pricing, rollout scope, or adoption from marketing language alone
- Never state causal impact unless the source supports that causal claim
- If a fact is unknown, say it is unknown
- If timing is unclear, use precise uncertainty language such as `as of publication, the company had not disclosed a launch date`
- If a claim is disputed or still developing, describe the dispute and the sourced positions rather than collapsing to a false certainty

## Implementation Prompt Artifact

The routine can use the following Facebook only policy prompt directly:

`Select the top AI or automation story for Facebook using the hard gates and weighted rubric below. Reject any candidate that lacks a primary source for the core claim, relies on rumor or aggregator recycling for a material fact, lacks a verified fact check verdict, falls under 600 words, omits required video links, lacks a real image path, uses banned dash formatting, or contains any fabricated or unverified material claim. Score only cleared candidates on relevance 20, real world impact 20, novelty and timeliness 15, evidence quality 20, Facebook fit 10, conversation potential 10, and asset readiness 5. Publish only the highest scoring story above threshold. Write in clear Facebook ready prose, 600 to 900 words, with a factual hook in the first two sentences, short paragraphs, no em dashes, no en dashes, no stylistic dash separators, no hype language, and a closing engagement question. Use no hashtags by default and never more than two specific hashtags. Attribute material claims to primary sources in the copy. If article fetch fails, use only the verified research brief and linked primary sources, omit any missing detail, and never imply the full article text was reviewed. If uncertainty remains, state it plainly and do not guess.`

## Fact Check Requirements

The Fact Checker must review every material claim and return exactly one verdict:

1. `verified`
2. `needs revision`
3. `cannot verify`

If the verdict is `needs revision` or `cannot verify`, the story cannot proceed to approval or publication.

The fact check record must identify:

1. Each material claim
2. The source used to verify it
3. Any downgraded or removed claims
4. Any unresolved uncertainty

## Approval Guardrails for the CCO

The CCO should approve only if all of the following are true:

1. The highest priority thesis is supported by the cited evidence
2. The story cleared fact check as `verified`
3. The story score justifies it as the lead Facebook candidate
4. The copy meets all format and style rules
5. The image path relies on a real image, or the fallback is documented
6. Required video links are present
7. There is no sign that marketing pressure altered the truth standard, sourcing threshold, or timing of verification

If any person asks for weakened verification or altered claims for performance reasons, the CCO must refuse and escalate to the CEO.

## Routine Behavior

The Facebook routine should execute in this order:

1. Collect at least three candidate stories when the news cycle allows.
2. Discard any candidate that fails a hard gate.
3. Score the remaining candidates using the weighted rubric.
4. Select the highest scoring candidate above threshold.
5. Produce the written draft.
6. Send the draft for independent fact check.
7. Approve only after a `verified` verdict.
8. Publish.
9. Send the verified editorial path to Video and Media only after publication approval.

## Escalation Rules

Escalate to the CEO if any of the following occurs:

1. Repeated fact check failures on similar claim types
2. Inability to source real images for a recurring content category
3. Persistent pressure from Marketing or other stakeholders to reduce verification
4. Team capacity too low to meet the standards above
5. A high risk story where the evidence remains contested after normal review

## Minimum Audit Trail

Each published Facebook story should leave behind:

1. Final score and category breakdown
2. Research brief with source links
3. Draft version sent to fact check
4. Fact check verdict and claim log
5. Final approved copy
6. Image source record
7. Video link record, if applicable

This audit trail is required so the routine remains reviewable, repeatable, and defensible.
