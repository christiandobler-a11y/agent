import { z } from "zod";
import { loadYamlConfig } from "../../config/files.js";

const viewport = z.object({
  width: z.number().int().min(320).max(3840),
  height: z.number().int().min(480).max(2160),
  scale: z.number().min(1).max(3),
});

export const crawlConfigSchema = z.object({
  navigation_timeout_s: z.number().positive().max(120),
  settle_ms: z.number().int().min(0).max(10_000),
  concurrency: z.number().int().positive().max(8),
  desktop: viewport,
  mobile: viewport,
  screenshot_screens: z.number().int().min(1).max(10),
  jpeg_quality: z.number().int().min(30).max(100),
  screenshot_dir: z.string().min(1),
  text_max_words: z.number().int().positive(),
  subpages: z.object({
    impressum: z.array(z.string().min(1)).min(1),
    services: z.array(z.string().min(1)),
  }),
});

export type CrawlConfig = z.infer<typeof crawlConfigSchema>;

export function loadCrawlConfig(): CrawlConfig {
  return loadYamlConfig("crawl.yaml", crawlConfigSchema);
}
