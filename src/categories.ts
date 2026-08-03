/**
 * Humanatic categories for this account (from Category List UI).
 * IDs come from category_selector.cfm?category=N links.
 */
export type HumanaticCategory = {
  id: number;
  key: string;
  name: string;
};

/** Categories observed on this reviewer's Category List. */
export const HUMANATIC_CATEGORIES: HumanaticCategory[] = [
  { id: 3, key: "inbound", name: "Inbound" },
  { id: 4, key: "live_conversation_outbound", name: "Live conversation - outbound" },
  { id: 87, key: "department", name: "Department" },
  { id: 223, key: "home_services_live_conversation", name: "Home Services: Live Conversation" },
  /** Note: account list uses hcat=78 (not generic Why Calling=25). */
  { id: 78, key: "rent_buzz_why_calling", name: "Rent Buzz: Why Calling" },
  { id: 20, key: "dealership_discussion", name: "Dealership Discussion" },
];

/** Full operator-provided ID map (for Tampermonkey refresh scripts / other accounts). */
export const CATEGORY_ID_REFERENCE: HumanaticCategory[] = [
  { id: 72, key: "ssb", name: "SSB" },
  { id: 135, key: "rfo", name: "RFO" },
  { id: 142, key: "car_wars", name: "Car wars" },
  { id: 3, key: "inbound", name: "Inbound" },
  { id: 4, key: "live_conversation_outbound", name: "Live conversation outbound" },
  { id: 20, key: "dd", name: "DD / Dealership Discussion" },
  { id: 87, key: "department", name: "Department" },
  { id: 83, key: "outbound_service_call_purpose", name: "Outbound service call purpose" },
  { id: 84, key: "outbound_invitation", name: "Outbound invitation" },
  { id: 7, key: "dsv", name: "DSV" },
  { id: 216, key: "handle_by_voice", name: "Handle by voice" },
  { id: 229, key: "call_recap_short", name: "Call recap short" },
  { id: 25, key: "why_calling", name: "Why calling / Rent Buzz: Why Calling" },
  { id: 240, key: "what_was_discuss", name: "What was discuss" },
  { id: 223, key: "home_services_live_conversation", name: "Home Services: Live Conversation" },
];

export const NO_CALLS_URL = "https://www.humanatic.com/pages/humfun/noCalls.cfm";
export const FACE_VERIFY_URL_HINT = "face_verify.cfm";
export const LOGIN_URL = "https://www.humanatic.com/pages/humfun/login.cfm";
export const CATEGORY_LIST_URL = "https://www.humanatic.com/pages/humfun/category.cfm";
export const PROFILE_URL = "https://www.humanatic.com/pages/humfun/profile.cfm";
export const BREAK_ROOM_URL_HINT = "break_room.cfm";
export const PRACTICE_HINTS = ["practice", "training", "quiz"];

export const categoryQueueUrl = (categoryId: number): string =>
  `https://www.humanatic.com/x19/category_selector.cfm?category=${categoryId}`;

export const findCategoryById = (id: number): HumanaticCategory | undefined =>
  HUMANATIC_CATEGORIES.find((c) => c.id === id) ||
  CATEGORY_ID_REFERENCE.find((c) => c.id === id);

export const findCategoryByKey = (key: string): HumanaticCategory | undefined => {
  const k = key.toLowerCase();
  return (
    HUMANATIC_CATEGORIES.find((c) => c.key === k || c.name.toLowerCase() === k) ||
    CATEGORY_ID_REFERENCE.find((c) => c.key === k || c.name.toLowerCase() === k)
  );
};
