import { chromium } from "playwright";

async function main() {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const pages = b.contexts().flatMap((c) => c.pages());
  console.log(
    "pages",
    pages.map((p) => p.url()),
  );
  const page = pages.find((p) => /review\.cfm/i.test(p.url())) || pages[0];
  if (!page) {
    console.log("no page");
    return;
  }
  const r = await page.evaluate(() => {
    const inactive = document.querySelector(".humfun-options-list-inactive") as HTMLElement | null;
    const msg = /selections will be available/i.test(document.body.innerText || "");
    const audio = document.querySelector("audio") as HTMLAudioElement | null;
    const bannerHits = Array.from(document.querySelectorAll("*"))
      .filter((el) => {
        const t = (el as HTMLElement).innerText || "";
        return /selections will be available/i.test(t) && el.children.length <= 2;
      })
      .slice(0, 6)
      .map((el) => {
        const h = el as HTMLElement;
        const st = getComputedStyle(h);
        return {
          tag: h.tagName,
          className: String(h.className).slice(0, 80),
          display: st.display,
          visibility: st.visibility,
          opacity: st.opacity,
          h: h.offsetHeight,
          text: (h.innerText || "").replace(/\s+/g, " ").slice(0, 100),
        };
      });
    return {
      url: location.href,
      msg,
      itemN: document.querySelectorAll(".humfun-options-list-item").length,
      radioN: document.querySelectorAll('input[type=radio]').length,
      inactive: inactive
        ? {
            h: inactive.offsetHeight,
            d: getComputedStyle(inactive).display,
            v: getComputedStyle(inactive).visibility,
            o: getComputedStyle(inactive).opacity,
            t: (inactive.textContent || "").slice(0, 120),
          }
        : null,
      audio: audio
        ? {
            ended: audio.ended,
            cur: audio.currentTime,
            dur: audio.duration,
            paused: audio.paused,
          }
        : null,
      sample: Array.from(document.querySelectorAll(".humfun-options-list-item"))
        .slice(0, 2)
        .map((el) => ({
          cls: el.className,
          pe: getComputedStyle(el as HTMLElement).pointerEvents,
          txt: ((el as HTMLElement).innerText || "").replace(/\s+/g, " ").slice(0, 60),
        })),
      bannerHits,
    };
  });
  console.log(JSON.stringify(r, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
