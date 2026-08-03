export type ReviewOption = {
  id: string;
  label: string;
  criteria: string;
  /** Stable DOM value attribute when present. */
  value?: string;
};

export type CategoryRule = {
  category_id: string;
  category_name: string;
  rules: string;
  options: ReviewOption[];
};

export type GrokDecision = {
  selected_option_id: string;
  reasoning: string;
  confidence: number;
};

export type ReviewLogEntry = {
  call_id: string;
  timestamp: string;
  category_id: string;
  category_name?: string;
  selected_option_id: string;
  confidence: number;
  reasoning: string;
  latency_ms: number;
  status:
    | "submitted"
    | "practice_selected"
    | "skipped_low_confidence"
    | "skipped_error"
    | "skipped_no_options";
};

export type DiscoveredSelectors = {
  callContainer: string;
  categoryInfoIcon: string;
  categoryTitle: string;
  optionInputs: string;
  transcriptElement: string;
  audioSource: string;
  submitButton: string;
  loginForm: string;
  emailInput: string;
  passwordInput: string;
  loginButton: string;
  queueEmpty?: string;
};

export type RunSummary = {
  started_at: string;
  finished_at?: string;
  reviews_attempted: number;
  reviews_submitted: number;
  reviews_skipped: number;
  categories_seen: string[];
  stop_reason?: string;
};
