// ==UserScript==
// @name         Indus Web Reviewer — Soft Assist
// @namespace    https://local.indus.web.reviewer
// @version      1.8.0
// @description  noCalls soft-reload every 3s. Intro soft-reload. No Category List thrash.
// @author       Indus Web Reviewer
// @match        https://www.humanatic.com/pages/humfun/profile.cfm*
// @match        https://www.humanatic.com/pages/humfun/noCalls.cfm*
// @match        https://www.humanatic.com/pages/humfun/category.cfm*
// @match        https://www.humanatic.com/pages/humfun/hcat_intro.cfm*
// @match        https://www.humanatic.com/x19/category_selector.cfm*
// @match        https://www.humanatic.com/x19/review.cfm*
// @grant        none
// @connect      127.0.0.1
// @connect      localhost
// ==/UserScript==

(function () {
  "use strict";

  const API = "http://127.0.0.1:3847/api/tm/target";
  const path = (location.pathname || "").toLowerCase();
  const href = String(location.href || "").toLowerCase();

  const introFor = (id) =>
    `https://www.humanatic.com/pages/humfun/hcat_intro.cfm?hcat=${id}&x19=1`;

  const hasReviewCta = () => {
    const t = (document.body && document.body.innerText) || "";
    return /review\s+calls/i.test(t);
  };

  const tick = async () => {
    try {
      const res = await fetch(API, { cache: "no-store" });
      if (!res.ok) {
        setTimeout(tick, 20000);
        return;
      }
      const target = await res.json();
      if (!target || !target.enabled) {
        setTimeout(tick, 30000);
        return;
      }
      if (target.paused) {
        console.log("[IWR-TM] Worker paused — soft assist idle");
        setTimeout(tick, 15000);
        return;
      }

      const catId = Number(target.categoryId);
      const introSeconds = Math.max(75, Number(target.refreshSeconds) || 90);

      // Live review — never navigate away
      if (href.includes("/x19/review.cfm") || /\/review\.cfm/i.test(href)) {
        console.log("[IWR-TM] Live review — idle");
        setTimeout(tick, introSeconds * 1000);
        return;
      }

      // noCalls — soft-reload every 3s (stock can appear without Category List hop)
      if (path.includes("nocalls.cfm")) {
        console.log("[IWR-TM] noCalls — soft reload in 3s");
        setTimeout(() => location.reload(), 3000);
        return;
      }

      // Category List — idle (worker only visits rarely after long empty)
      if (path.includes("category.cfm")) {
        console.log("[IWR-TM] Category List — idle");
        setTimeout(tick, introSeconds * 1000);
        return;
      }

      // Intro / selector — soft reload only
      if (path.includes("hcat_intro") || path.includes("category_selector")) {
        if (hasReviewCta()) {
          console.log("[IWR-TM] Intro has REVIEW CALLS — soft refresh in", introSeconds, "s");
        } else {
          console.log("[IWR-TM] Intro soft refresh in", introSeconds, "s");
        }
        setTimeout(() => location.reload(), introSeconds * 1000);
        return;
      }

      // Profile only — go to target intro once
      if (path.includes("profile.cfm")) {
        if (Number.isFinite(catId) && catId > 0) {
          console.log("[IWR-TM] Profile → intro #" + catId);
          setTimeout(() => {
            location.href = introFor(catId);
          }, 2500);
          return;
        }
        setTimeout(tick, introSeconds * 1000);
        return;
      }

      setTimeout(tick, introSeconds * 1000);
    } catch (e) {
      console.warn("[IWR-TM] API unreachable?", e);
      setTimeout(tick, 25000);
    }
  };

  setTimeout(tick, 2000 + Math.floor(Math.random() * 1500));
})();
