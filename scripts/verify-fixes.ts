/**
 * Offline verification for the transcript / loop / heuristic fixes.
 *
 * Runs with no browser and no Humanatic session — it exercises the pure logic
 * that was wrong. Run with:  npm run verify
 */
import fs from "fs";
import path from "path";
import { looksLikeInstructions } from "../src/humanatic";
import { heuristicDecide } from "../src/heuristicDecision";
import { parseAvailableCount } from "../src/categoryInventory";
import { config } from "../src/config";
import { CategoryRule } from "../src/types";

let passed = 0;
let failed = 0;

const check = (name: string, condition: boolean, detail = "") => {
  if (condition) {
    console.log(`  PASS  ${name}`);
    passed += 1;
  } else {
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
    failed += 1;
  }
};

const section = (title: string) => console.log(`\n${title}\n${"-".repeat(title.length)}`);

/** The exact kind of text that used to be sent to the LLM as a "transcript". */
const INSTRUCTIONS_WALL = `
Category Instructions: Inbound
The purpose of this category Inbound is to determine whether or not the call was
handled by a live, qualified employee or interactive system. Specific criteria
must be met for it to be considered handled by a qualified employee.

Here are the options:
Handled by a qualified employee or interactive system
Not handled: voicemail, left message
Not handled: nobody there, hung up during bridge, wrong number, spam

Practice Questions
Please complete all practice questions and then verify that you understand the
requirements of this new project by entering your initials below.
SUBMIT REVIEW
`.trim();

const REAL_TRANSCRIPT = `
Thank you for calling Riverside Dental, this is Megan speaking, how can I help you today?
Hi Megan, I'm calling to see if I can move my cleaning appointment from Thursday to next week.
Absolutely, let me pull up your file. Can I get your last name and date of birth?
Sure, it's Alvarez, and my birthday is March the 4th, 1987.
Perfect, I see you here. I have an opening next Tuesday at 2:15, would that work?
Tuesday at 2:15 is great, thank you so much.
Wonderful, you're all set. We'll send a reminder text the day before.
`.trim();

const CATEGORY: CategoryRule = {
  category_id: "3",
  category_name: "Inbound",
  rules: "Determine whether the call was handled by a qualified employee.",
  options: [
    {
      id: "987654",
      label: "Handled by a qualified employee or interactive system",
      criteria: "A live employee or IVR engaged the caller.",
    },
    {
      id: "127600",
      label: "Not handled: nobody there, hung up during bridge, wrong number, spam",
      criteria: "No one engaged the caller.",
    },
    {
      id: "127606",
      label: "Not handled: voicemail, left message",
      criteria: "Call reached voicemail.",
    },
  ],
};

const OPTION_LABELS = CATEGORY.options.map((o) => o.label);

// ---------------------------------------------------------------------------
section("1. Transcript guard (the bug that corrupted every decision)");

check(
  "instructions wall is rejected",
  looksLikeInstructions(INSTRUCTIONS_WALL, OPTION_LABELS) === true,
);
check(
  "bare option-label list is rejected",
  looksLikeInstructions(OPTION_LABELS.join("\n"), OPTION_LABELS) === true,
);
check(
  'the historical "was the call handled by..." question is rejected',
  looksLikeInstructions("Was the call handled by a qualified employee or interactive system?", OPTION_LABELS) === true,
);
check("empty text is rejected", looksLikeInstructions("", OPTION_LABELS) === true);
check(
  "a genuine conversation is accepted",
  looksLikeInstructions(REAL_TRANSCRIPT, OPTION_LABELS) === false,
);

// ---------------------------------------------------------------------------
section("2. Heuristic gating (the bypassed confidence gate)");

const heuristic = heuristicDecide(CATEGORY, REAL_TRANSCRIPT);

check("heuristic still produces a decision", heuristic !== null);
check(
  'heuristic is tagged source="heuristic"',
  heuristic?.source === "heuristic",
  `got ${heuristic?.source}`,
);
check(
  `heuristic confidence is BELOW threshold (${config.confidenceThreshold})`,
  (heuristic?.confidence ?? 1) < config.confidenceThreshold,
  `got ${heuristic?.confidence}`,
);
check(
  "HEURISTIC_SUBMIT defaults to off",
  config.heuristicSubmit === false || process.env.HEURISTIC_SUBMIT === "1",
);

// Simulate the gate exactly as the worker applies it.
const wouldSubmit = (d: { source?: string; confidence: number }) => {
  if (d.source === "heuristic" && !config.heuristicSubmit) return false;
  if (d.source !== "heuristic" && d.confidence < config.confidenceThreshold) return false;
  return true;
};

check("heuristic decision is BLOCKED by default", wouldSubmit(heuristic!) === false);
check(
  "confident LLM decision still passes",
  wouldSubmit({ source: "llm", confidence: 0.95 }) === true,
);
check(
  "unconfident LLM decision is still blocked",
  wouldSubmit({ source: "llm", confidence: 0.5 }) === false,
);

// ---------------------------------------------------------------------------
section("3. Queue loop circuit breaker");

const workerSrc = fs.readFileSync(
  path.resolve(__dirname, "../src/waitWorker.ts"),
  "utf8",
);

check(
  "hardcoded 4s infinite retry is gone",
  !/waitMs:\s*4000,\s*\n\s*label:\s*`#\$\{current\.categoryId\} still shows/.test(workerSrc),
);
check("retry cap constant exists", /MAX_SAME_CATEGORY_RETRIES\s*=\s*\d+/.test(workerSrc));
check("categories can be benched", /function benchCategory|const benchCategory/.test(workerSrc));
check(
  "emptyStreak is now READ, not just incremented",
  /recoverFromEmpty\(page,\s*categoryId,\s*emptyStreak\)/.test(workerSrc),
);
check(
  "recovery reports whether it rotated",
  /rotated:\s*(true|false)/.test(workerSrc) && /recovery\.rotated/.test(workerSrc),
);

// ---------------------------------------------------------------------------
section("4. Transcript ordering (audio must win over DOM text)");

const humanaticSrc = fs.readFileSync(
  path.resolve(__dirname, "../src/humanatic.ts"),
  "utf8",
);
const captureBody = humanaticSrc.slice(humanaticSrc.indexOf("export const captureTranscript"));
const audioIdx = captureBody.indexOf("findAudioUrl(page)");
const domIdx = captureBody.indexOf("transcriptSel");

check("audio lookup happens before DOM scrape", audioIdx > -1 && audioIdx < domIdx);
check(
  "loose [class*='call-'] scrape is removed",
  !humanaticSrc.includes("[class*='call-']"),
);
check(
  "audio fetch forwards session cookies",
  /cookies\(audioUrl\)/.test(humanaticSrc),
);

// ---------------------------------------------------------------------------
section("5. Inventory parsing (unchanged behaviour sanity check)");

check('parses "English - 4"', parseAvailableCount("English - 4") === 4);
check('parses "English: 12"', parseAvailableCount("English: 12") === 12);
check("empty means zero", parseAvailableCount("") === 0);

// ---------------------------------------------------------------------------
console.log(`\n${"=".repeat(50)}`);
console.log(`${passed} passed, ${failed} failed`);
console.log("=".repeat(50));

if (failed > 0) process.exit(1);
console.log("\nOffline checks green. Next: run the live smoke test (see README-FIXES.md).");
