import { chromium } from "playwright";
import { config } from "../src/config";

(async () => {
  const b = await chromium.connectOverCDP(`http://127.0.0.1:${config.chromeDebugPort}`);
  const p = b.contexts()[0]!.pages().find((x) => !x.isClosed())!;
  const info = await p.evaluate(() => {
    const forms = Array.from(document.querySelectorAll("form")).map((f) => ({
      action: f.action,
      html: f.outerHTML.slice(0, 600),
    }));
    const candidates = Array.from(document.querySelectorAll("input, button, a")).
      filter((el) => /submit|initial|subbutton|confirm/i.test(el.outerHTML))
      .map((el) => {
        const input = el as HTMLInputElement;
        return {
          tag: el.tagName,
          type: input.type,
          name: input.name,
          value: input.value || (el.textContent || "").slice(0, 40),
          disabled: input.disabled,
          cls: el.className,
        };
      });
    return {
      forms,
      candidates,
      bodyTail: (document.body?.innerText || "").slice(-900),
    };
  });
  console.log(JSON.stringify(info, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
