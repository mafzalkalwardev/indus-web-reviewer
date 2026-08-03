const SELECTORS = {
  categoryInfoIcon: ".category-info-icon, [data-tooltip]",
  transcriptElement: ".transcript-text, .call-transcript",
  optionInputs: "input[type=radio], input[type=checkbox]",
  submitButton: "button[type=submit], .submit-review",
};

const getCategoryRules = () => {
  const icon = document.querySelector(SELECTORS.categoryInfoIcon);
  if (!icon) return null;

  icon.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

  const popup = document.querySelector(".tooltip-content, .popover, .category-info-popup");
  if (!popup) return null;

  const categoryName = popup.querySelector("h1, h2, .title")?.textContent?.trim() || undefined;
  const rulesText = Array.from(popup.querySelectorAll("p, li, .rule-text")).map((node) => node.textContent?.trim()).filter(Boolean).join("\n");
  const options = Array.from(document.querySelectorAll<HTMLInputElement>(SELECTORS.optionInputs)).map((input) => {
    const label = document.querySelector(`label[for='${input.id}']`)?.textContent?.trim() || input.getAttribute("aria-label") || input.value || "Unknown option";
    return { id: input.id || `option-${Math.random().toString(16).slice(2)}`, label, criteria: label };
  });

  return {
    categoryName,
    rules: rulesText,
    options,
  };
};

const getTranscript = () => {
  const transcript = document.querySelector(SELECTORS.transcriptElement)?.textContent?.trim();
  return transcript || null;
};

window.addEventListener("load", () => {
  const payload = {
    type: "HUMANATIC_REVIEW_PAGE_READY",
    data: {
      rules: getCategoryRules(),
      transcript: getTranscript(),
    },
  };

  window.postMessage(payload, window.location.origin);
});
