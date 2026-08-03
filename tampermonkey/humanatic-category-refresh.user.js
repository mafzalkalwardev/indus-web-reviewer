// ==UserScript==
// @name         Humanatic Category Refresh (Dashboard-driven)
// @namespace    https://local.humanatic.reviewr
// @version      1.0.0
// @description  Polls local Control API for active category and refreshes the queue until a call appears. Does not touch active review screens.
// @author       Huamantic Reviewr
// @match        https://www.humanatic.com/pages/humfun/noCalls.cfm*
// @match        https://www.humanatic.com/pages/humfun/category.cfm*
// @match        https://www.humanatic.com/x19/category_selector.cfm*
// @match        https://www.humanatic.com/pages/humfun/break_room.cfm*
// @grant        none
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(function () {
  "use strict";

  const API = "http://127.0.0.1:3847/api/tm/target";
  const DEFAULT_SECONDS = 30;

  const isReviewScreen = () => {
    const radios = document.querySelectorAll('input[type="radio"]').length;
    const practice = document.querySelectorAll(".practice-review").length;
    if (practice >= 2) return false;
    if (radios >= 4) return true;
    if (radios >= 3 && document.querySelector("audio")) return true;
    return false;
  };

  const path = location.pathname.toLowerCase();
  if (path.includes("hcat_intro") && isReviewScreen()) {
    // Never refresh while AI is reviewing
    return;
  }

  const queueUrl = (categoryId) =>
    `https://www.humanatic.com/x19/category_selector.cfm?category=${categoryId}`;

  const tick = async () => {
    try {
      if (isReviewScreen()) return;

      const res = await fetch(API, { cache: "no-store" });
      if (!res.ok) return;
      const target = await res.json();
      if (!target || !target.enabled || target.categoryId == null) return;

      const seconds = Math.max(15, Number(target.refreshSeconds) || DEFAULT_SECONDS);
      const href = target.queueUrl || queueUrl(target.categoryId);
      const onNoCalls = /nocalls\.cfm/i.test(location.href);
      const onCategoryList = /\/category\.cfm/i.test(location.href);
      const onSelector = /category_selector\.cfm/i.test(location.href);
      const onBreak = /break_room\.cfm/i.test(location.href);

      if (onBreak) return; // let the wait-worker / human continue button handle this

      const currentCat = (location.href.match(/[?&]category=(\d+)/i) || [])[1];
      const needSwitch =
        onNoCalls ||
        onCategoryList ||
        (onSelector && String(currentCat) !== String(target.categoryId));

      if (needSwitch) {
        console.log(
          `[HR-TM] Refresh → category ${target.categoryId} (${target.categoryName || ""}) in ~${seconds}s cadence`,
        );
        // Small jitter so we don't look like a fixed timer bot
        const jitter = Math.floor(Math.random() * 4000);
        setTimeout(() => {
          if (isReviewScreen()) return;
          location.href = href;
        }, 800 + jitter);
        // Schedule next poll after refreshSeconds (page may unload)
        setTimeout(tick, seconds * 1000);
        return;
      }

      // Already on correct selector but still empty — soft reload after interval
      if (onSelector) {
        setTimeout(() => {
          if (isReviewScreen()) return;
          location.reload();
        }, seconds * 1000 + Math.floor(Math.random() * 3000));
        return;
      }

      setTimeout(tick, seconds * 1000);
    } catch (e) {
      console.warn("[HR-TM] API unreachable — is Control API running on :3847?", e);
      setTimeout(tick, 15000);
    }
  };

  // Initial delay so login / face verify settle
  setTimeout(tick, 5000 + Math.floor(Math.random() * 3000));
})();
