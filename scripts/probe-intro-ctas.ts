import { chromium } from "playwright";

(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9222");
  const p = b.contexts()[0].pages().find((x) => /humanatic/i.test(x.url()))!;
  // Scroll full page
  await p.evaluate(async () => {
    for (let i = 0; i < 12; i++) {
      window.scrollBy(0, 600);
      await new Promise((r) => setTimeout(r, 200));
    }
    window.scrollTo(0, document.body.scrollHeight);
  });
  await p.waitForTimeout(800);
  const dump = await p.evaluate(() => {
    const clickables = Array.from(
      document.querySelectorAll("a, button, input[type=button], input[type=submit], [onclick], [role=button]"),
    ).map((el) => {
      const h = el as HTMLElement;
      const r = h.getBoundingClientRect();
      return {
        tag: el.tagName,
        text: (h.innerText || (el as HTMLInputElement).value || "").replace(/\s+/g, " ").trim().slice(0, 100),
        href: (el as HTMLAnchorElement).href || "",
        cls: String(h.className || "").slice(0, 60),
        vis: r.width > 0 && r.height > 0 && getComputedStyle(h).visibility !== "hidden",
      };
    }).filter((c) => c.text || c.href);
    const imgs = Array.from(document.querySelectorAll("img[alt], img[title]")).map((i) => ({
      alt: (i as HTMLImageElement).alt,
      title: (i as HTMLImageElement).title,
      src: ((i as HTMLImageElement).src || "").slice(-40),
    }));
    return {
      url: location.href,
      scrollH: document.body.scrollHeight,
      clickables: clickables.slice(0, 40),
      imgs: imgs.slice(0, 20),
      hasReviewWord: /review\s*calls|start\s*review|begin\s*review|get\s*calls/i.test(document.body.innerText),
    };
  });
  console.log(JSON.stringify(dump, null, 2));
  await b.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
