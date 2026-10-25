type AnalyticsData = Record<string, string | number | boolean>;

declare global {
  interface Window {
    umami?: {
      track(name: string, data?: AnalyticsData): void | Promise<unknown>;
    };
  }
}

/** Custom events only; Publishing manages the tracker and automatic pageviews. */
export function trackEvent(name: string, data?: AnalyticsData): void {
  if (typeof window === "undefined") return;
  try {
    const result = window.umami?.track(name, data);
    // A blocked tracker must not interrupt an action or reject unhandled.
    if (result) void Promise.resolve(result).catch(() => {});
  } catch {
    // Analytics must never break the app.
  }
}
