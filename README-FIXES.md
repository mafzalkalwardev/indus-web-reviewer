# Fixes — transcript integrity, queue loop, heuristic gating

Three bugs were compounding. In short: the reviewer was reading the **instructions
page** instead of the call, agreeing with it at confidence 1.0, and submitting.

## 1. Transcript was never a transcript

`src/humanatic.ts` → `captureTranscript()`

**Before:** a loose DOM sweep (`[class*='call-']`, `pre`, `textarea`, …) returned the
first element over 50 chars. On a Humanatic review page that is the category
instructions wall. The audio → Whisper branch sat *below* it and never ran.

Evidence in `data/reviews.json`:

> `"The transcript asks if the call was handled by a qualified employee..."` — confidence `1` — `submitted`

**After:**

- Audio → Whisper runs **first** and is the source of truth.
- DOM text is only accepted from a dedicated transcript container.
- Everything passes through `looksLikeInstructions()`, which rejects text
  containing instruction markers or the verbatim option labels.
- If neither yields a real transcript, it **throws** — logged as
  `skipped_no_transcript`. No submission happens on instruction text, ever.
- Whisper's audio fetch now forwards the Playwright session cookies and rejects
  HTML/undersized responses (the old bare `fetch` would have 403'd).

## 2. Infinite 4-second queue loop

`src/waitWorker.ts` → `recoverFromEmpty()`

**Before:** when the Category List still advertised availability for the current
category, recovery unconditionally returned "retry in 4s" — forever. `worker-state.json`
was frozen at `"#3 still shows English - 4 — retry REVIEW CALLS in 4s"`.
An `emptyStreak` counter existed, was incremented in five places, and was **never read**.

**After:**

- `recoverFromEmpty(page, currentId, streak)` retries at most
  `MAX_SAME_CATEGORY_RETRIES` (3) with exponential backoff (4s → 8s → 16s, capped 30s).
- After that the category is **benched** for 5 minutes and excluded from rotation,
  so the worker can't bounce straight back into it.
- All eight call sites now go through one `runRecovery()` helper that owns the
  counter and resets it only on a genuine rotation.

## 3. Heuristic fallback bypassed the confidence gate

`src/heuristicDecision.ts`, `src/config.ts`, `src/grok.ts`

**Before:** when Groq hit its daily token limit, `heuristicDecide()` returned a
hardcoded confidence of **0.88** against a **0.85** threshold — the gate was
mathematically impossible to fail. Combined with bug #1 it keyword-matched
against a page that contains all the option labels verbatim.

**After:**

- Decisions carry `source: "llm" | "heuristic"`.
- Heuristic confidence dropped to honest values (0.6 / 0.4).
- Heuristics are gated by `HEURISTIC_SUBMIT` (**default off**), not by the
  confidence number. Blocked ones log as `skipped_heuristic_blocked`.
- LLM decisions are still gated by `CONFIDENCE_THRESHOLD` as before.

---

## Verify

### Offline (no browser, no session, no API quota)

```bash
npm run check
```

Runs `tsc --noEmit` then the 20 assertions in `scripts/verify-fixes.ts`.
Everything must be green before touching a live account.

### Live smoke test — practice mode, no submissions

```bash
# .env
PRACTICE_MODE=1
HEURISTIC_SUBMIT=0
```

```bash
npm run worker:wait
```

Watch for, in order:

1. `[whisper] <file>.mp3` followed by `[whisper] chars=<N>` where **N is in the
   hundreds** — this is the fix working. If you see `chars=0`, or a
   `session cookies missing or expired` error, the audio URL needs auth work.
2. `[wait] Review cat=Inbound options=3 transcript=<N>` — N should roughly match
   the whisper char count, **not** ~8000 (that was the instructions wall).
3. On an empty queue: `Retry 1/3 … Retry 2/3 … Retry 3/3` then
   `Benching #N for 300s`. It must **not** repeat the same retry line forever.

Then check the tail of `data/reviews.json`. Reasoning should reference actual
call content ("caller asked to reschedule", "reached voicemail"), never
"the transcript asks…".

### Going live

Only after the practice run looks right:

```bash
PRACTICE_MODE=0
```

Leave `HEURISTIC_SUBMIT=0` unless you have separately validated heuristic
accuracy against known-good calls.

## Known follow-ups (not fixed here)

- **Groq daily token limit** was exhausted (`TPD: Limit 100000`). Fixing #1 cuts
  usage substantially — you were spending ~1,250 tokens per call on instruction
  text — but a paid tier or a smaller decision model may still be needed.
- `data/reviews.json` contains historical `submitted` rows decided on
  instructions text. Those account submissions can't be retracted from here.
- `PRACTICE_MODE` defaults to `1` in `src/config.ts`, but the dashboard's
  `worker-state.json` carries its own `practiceMode` flag. Confirm which one you
  intend to be authoritative.
