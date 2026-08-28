/**
 * Bring automation Chrome into view (un-minimize + on-screen position) via CDP.
 * Background launch uses --window-position=-32000,-32000 — restoring "normal"
 * alone leaves the window off-screen, so we always set left/top/size.
 */
import { Page } from "playwright";
import { config } from "./config";

export const showBrowserWindow = async (page: Page): Promise<boolean> => {
  try {
    const session = await page.context().newCDPSession(page);
    const { windowId } = (await session.send("Browser.getWindowForTarget")) as {
      windowId: number;
    };
    const width = Math.max(1024, Math.min(config.browserWidth || 1280, 1600));
    const height = Math.max(720, Math.min(config.browserHeight || 900, 1000));
    // Some Chrome builds reject windowState+size in one call — do state then bounds
    await session.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "normal" },
    }).catch(() => undefined);
    await session.send("Browser.setWindowBounds", {
      windowId,
      bounds: {
        left: 40,
        top: 40,
        width,
        height,
        windowState: "normal",
      },
    });
    await page.bringToFront().catch(() => undefined);
    console.log(`[browser] Watch: Chrome restored to ${width}x${height} @ 40,40`);
    return true;
  } catch (e) {
    console.warn(`[browser] showBrowserWindow failed: ${(e as Error).message}`);
    return false;
  }
};

export const minimizeBrowserWindow = async (page: Page): Promise<boolean> => {
  try {
    const session = await page.context().newCDPSession(page);
    const { windowId } = (await session.send("Browser.getWindowForTarget")) as {
      windowId: number;
    };
    await session.send("Browser.setWindowBounds", {
      windowId,
      bounds: { windowState: "minimized" },
    });
    return true;
  } catch {
    return false;
  }
};

/** Mute or unmute all media elements on the page. */
export const setPageAudioMuted = async (page: Page, muted: boolean): Promise<void> => {
  await page
    .evaluate((m) => {
      document.querySelectorAll("audio, video").forEach((el) => {
        const media = el as HTMLMediaElement;
        media.muted = m;
        if (!m) media.volume = 1;
        else media.volume = 0;
      });
    }, muted)
    .catch(() => undefined);
};
