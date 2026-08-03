import { Page } from "playwright";
import { CategoryRule, GrokDecision, RunSummary } from "./types";
import {
  inspectPortal,
  extractRulesFromInfoIcon,
  captureTranscript,
  submitReviewChoice,
  selectReviewChoice,
  readLiveOptions,
  waitForNextCall,
  getCallFingerprint,
  isQueueEmpty,
} from "./humanatic";
import { evaluateTranscript } from "./grok";
import { appendReviewLog, loadCategoryCache, saveCategoryCache, saveRunSummary } from "./storage";
import { config } from "./config";
import { discoverReviewSelectors, savePageSnapshot } from "./domDiscovery";
import { ensureClearOfBreakRoom } from "./breakRoom";

export type FSMState =
  | "IDLE"
  | "DISCOVER"
  | "EXTRACT_RULES"
  | "FETCH_TRANSCRIPT"
  | "EVALUATE_GROK"
  | "VALIDATE_SELECTION"
  | "SUBMIT_REVIEW"
  | "WAIT_NEXT"
  | "COMPLETE";

export class ReviewEngine {
  private categoryCache = loadCategoryCache();
  private summary: RunSummary = {
    started_at: new Date().toISOString(),
    reviews_attempted: 0,
    reviews_submitted: 0,
    reviews_skipped: 0,
    categories_seen: [],
  };

  constructor(private page: Page) {}

  private findCachedCategory(categoryId: string) {
    return this.categoryCache.find((item) => item.category_id === categoryId);
  }

  private async cacheCategory(category: CategoryRule) {
    const existing = this.findCachedCategory(category.category_id);
    if (!existing) {
      this.categoryCache.push(category);
      saveCategoryCache(this.categoryCache);
    } else {
      // Refresh options from live DOM when ids may have changed
      existing.options = category.options;
      existing.rules = category.rules || existing.rules;
      existing.category_name = category.category_name || existing.category_name;
      saveCategoryCache(this.categoryCache);
    }
  }

  private trackCategory(categoryId: string) {
    if (!this.summary.categories_seen.includes(categoryId)) {
      this.summary.categories_seen.push(categoryId);
    }
  }

  private async validateDecision(category: CategoryRule, decision: GrokDecision): Promise<void> {
    const optionExists = category.options.some((opt) => opt.id === decision.selected_option_id);
    if (!optionExists) {
      throw new Error(
        `Decision option ID not found in category options: ${decision.selected_option_id}`,
      );
    }
    if (decision.confidence < config.confidenceThreshold) {
      throw new Error(`Low Grok confidence: ${decision.confidence}`);
    }
  }

  private async processOneCall(stateRef: { state: FSMState }): Promise<"ok" | "skipped" | "fatal"> {
    let categoryRule: CategoryRule | undefined;
    let transcript = "";
    let decision: GrokDecision | undefined;
    const started = Date.now();

    try {
      const metadata = await inspectPortal(this.page);
      this.trackCategory(metadata.categoryId);

      stateRef.state = "EXTRACT_RULES";
      categoryRule = this.findCachedCategory(metadata.categoryId);
      const liveOptions = await readLiveOptions(this.page);

      if (!categoryRule) {
        categoryRule = await extractRulesFromInfoIcon(this.page);
        categoryRule.category_id = metadata.categoryId;
        categoryRule.category_name = metadata.categoryName || categoryRule.category_name;
        if (liveOptions.length) categoryRule.options = liveOptions;
        await this.cacheCategory(categoryRule);
      } else if (liveOptions.length) {
        categoryRule.options = liveOptions;
        await this.cacheCategory(categoryRule);
      }

      if (!categoryRule.options.length) {
        appendReviewLog({
          call_id: metadata.callId || `call-${Date.now()}`,
          timestamp: new Date().toISOString(),
          category_id: metadata.categoryId,
          category_name: categoryRule.category_name,
          selected_option_id: "",
          confidence: 0,
          reasoning: "No options on page",
          latency_ms: Date.now() - started,
          status: "skipped_no_options",
        });
        this.summary.reviews_skipped += 1;
        return "skipped";
      }

      stateRef.state = "FETCH_TRANSCRIPT";
      transcript = await captureTranscript(this.page);
      console.log(
        `[engine] Category=${categoryRule.category_name} options=${categoryRule.options.length} transcriptChars=${transcript.length}`,
      );

      stateRef.state = "EVALUATE_GROK";
      decision = await evaluateTranscript(categoryRule, transcript);

      stateRef.state = "VALIDATE_SELECTION";
      try {
        await this.validateDecision(categoryRule, decision);
      } catch (validationError) {
        const msg = (validationError as Error).message;
        const lowConfidence = msg.includes("Low Grok confidence");
        console.warn(`[engine] Skipping submission: ${msg}`);
        appendReviewLog({
          call_id: metadata.callId || `call-${Date.now()}`,
          timestamp: new Date().toISOString(),
          category_id: metadata.categoryId,
          category_name: categoryRule.category_name,
          selected_option_id: decision.selected_option_id,
          confidence: decision.confidence,
          reasoning: `${decision.reasoning} | SKIP: ${msg}`,
          latency_ms: Date.now() - started,
          status: lowConfidence ? "skipped_low_confidence" : "skipped_error",
        });
        this.summary.reviews_skipped += 1;
        return "skipped";
      }

      stateRef.state = "SUBMIT_REVIEW";
      if (config.practiceMode) {
        await selectReviewChoice(this.page, decision.selected_option_id);
        appendReviewLog({
          call_id: metadata.callId || `call-${Date.now()}`,
          timestamp: new Date().toISOString(),
          category_id: metadata.categoryId,
          category_name: categoryRule.category_name,
          selected_option_id: decision.selected_option_id,
          confidence: decision.confidence,
          reasoning: `[PRACTICE] ${decision.reasoning}`,
          latency_ms: Date.now() - started,
          status: "practice_selected",
        });
        this.summary.reviews_submitted += 1;
        console.log(
          `[engine] PRACTICE selected option=${decision.selected_option_id} confidence=${decision.confidence} (not submitted)`,
        );
        return "ok";
      }

      await submitReviewChoice(this.page, decision.selected_option_id);

      appendReviewLog({
        call_id: metadata.callId || `call-${Date.now()}`,
        timestamp: new Date().toISOString(),
        category_id: metadata.categoryId,
        category_name: categoryRule.category_name,
        selected_option_id: decision.selected_option_id,
        confidence: decision.confidence,
        reasoning: decision.reasoning,
        latency_ms: Date.now() - started,
        status: "submitted",
      });
      this.summary.reviews_submitted += 1;
      console.log(
        `[engine] Submitted option=${decision.selected_option_id} confidence=${decision.confidence}`,
      );
      // Human pacing between live submits (reduces Break Room)
      const pace = 3500 + Math.floor(Math.random() * 4500);
      console.log(`[engine] Cooling down ${pace}ms…`);
      await this.page.waitForTimeout(pace);
      return "ok";
    } catch (error) {
      console.error(`FSM state ${stateRef.state} failed:`, error);
      appendReviewLog({
        call_id: `call-${Date.now()}`,
        timestamp: new Date().toISOString(),
        category_id: categoryRule?.category_id || "unknown",
        category_name: categoryRule?.category_name,
        selected_option_id: decision?.selected_option_id || "",
        confidence: decision?.confidence || 0,
        reasoning: (error as Error).message,
        latency_ms: Date.now() - started,
        status: "skipped_error",
      });
      this.summary.reviews_skipped += 1;
      await savePageSnapshot(this.page, `error-${stateRef.state}`).catch(() => undefined);
      return "skipped";
    }
  }

  public async run(): Promise<RunSummary> {
    const stateRef = { state: "IDLE" as FSMState };

    stateRef.state = "DISCOVER";
    const discovery = await discoverReviewSelectors(this.page);
    discovery.notes.forEach((n) => console.log(`[dom] ${n}`));

    if (!discovery.reviewUiFound) {
      await savePageSnapshot(this.page, "no-review-ui");
      this.summary.stop_reason = "review_ui_not_found";
      this.summary.finished_at = new Date().toISOString();
      saveRunSummary(this.summary);
      throw new Error(
        "Review UI not found on page. See analysis-output/ for HTML/screenshot. Navigate to a call review page and re-run.",
      );
    }

    while (this.summary.reviews_attempted < config.maxReviewCalls) {
      await ensureClearOfBreakRoom(this.page);

      if (await isQueueEmpty(this.page)) {
        this.summary.stop_reason = "queue_empty";
        break;
      }

      this.summary.reviews_attempted += 1;
      console.log(
        `[engine] === Call ${this.summary.reviews_attempted}/${config.maxReviewCalls} ===`,
      );

      const fingerprint = await getCallFingerprint(this.page);
      const result = await this.processOneCall(stateRef);

      if (result === "fatal") {
        this.summary.stop_reason = "fatal_error";
        break;
      }

      stateRef.state = "WAIT_NEXT";
      const next = await waitForNextCall(this.page, fingerprint, config.reviewIdleTimeoutMs);
      if (next === "empty") {
        this.summary.stop_reason = "queue_empty";
        break;
      }
      if (next === "idle") {
        this.summary.stop_reason = "idle_timeout";
        break;
      }
      // ready — loop continues
    }

    if (!this.summary.stop_reason) {
      this.summary.stop_reason =
        this.summary.reviews_attempted >= config.maxReviewCalls ? "max_calls" : "complete";
    }

    stateRef.state = "COMPLETE";
    this.summary.finished_at = new Date().toISOString();
    saveRunSummary(this.summary);

    console.log("[engine] Run summary:", JSON.stringify(this.summary, null, 2));
    return this.summary;
  }
}
