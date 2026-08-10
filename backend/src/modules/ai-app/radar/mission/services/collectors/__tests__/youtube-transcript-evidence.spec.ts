import { RadarSource } from "@prisma/client";
import {
  assessTranscriptQuality,
  YoutubeCollector,
} from "../youtube-collector.service";

const feedItem = {
  title: "Evidence video",
  link: "https://www.youtube.com/watch?v=abcdefghijk",
  isoDate: "2026-08-09T12:00:00Z",
  author: "Creator",
  "yt:videoId": "abcdefghijk",
  "yt:channelId": "UCabcdefghijklmnopqrstuv",
  "media:group": { "media:description": ["RSS description"] },
};

function source(fetchTranscript: boolean) {
  return {
    identifier: "UCabcdefghijklmnopqrstuv",
    config: { fetchTranscript },
  } as unknown as RadarSource;
}

describe("YouTube transcript evidence gate", () => {
  it("rejects empty, provider-error, and short transcript negative controls", () => {
    expect(assessTranscriptQuality("").reason).toBe("empty_transcript");
    expect(
      assessTranscriptQuality("Transcript is unavailable for this video"),
    ).toMatchObject({ accepted: false, reason: "provider_error_text" });
    expect(assessTranscriptQuality("too short", 100)).toMatchObject({
      accepted: false,
      reason: "too_short:9<100",
    });
  });

  it("accepts substantive transcript content", () => {
    const quality = assessTranscriptQuality("evidence ".repeat(40), 200);
    expect(quality).toMatchObject({
      accepted: true,
      reason: "quality_gate_passed",
    });
  });

  it("uses the native ContentFetchService result and records evidence", async () => {
    const content = "native transcript evidence ".repeat(20);
    const contentFetch = {
      fetchFromYoutubeUrl: jest.fn().mockResolvedValue({
        title: "Evidence video",
        content,
        url: feedItem.link,
        isBilingual: false,
        metadata: { fetchedAt: "2026-08-10T00:00:00Z" },
      }),
    };
    const collector = new YoutubeCollector(contentFetch);
    const parser = (collector as unknown as { parser: { parseURL: jest.Mock } })
      .parser;
    parser.parseURL = jest.fn().mockResolvedValue({ items: [feedItem] });

    const items = await collector.fetch(source(true), {
      since: new Date("2026-08-01T00:00:00Z"),
      perSourceLimit: 1,
      userId: "user-1",
    });
    expect(items[0]?.content).toBe(content);
    expect(items[0]?.raw).toMatchObject({
      evidence: {
        provider: "youtube",
        externalId: "abcdefghijk",
        transcript: {
          status: "accepted",
          reason: "quality_gate_passed",
          fetchedAt: "2026-08-10T00:00:00Z",
        },
      },
    });
  });

  it("retains RSS description and truthful rejection evidence", async () => {
    const contentFetch = {
      fetchFromYoutubeUrl: jest.fn().mockResolvedValue({
        title: "Evidence video",
        content: "short",
        url: feedItem.link,
        metadata: {},
      }),
    };
    const collector = new YoutubeCollector(contentFetch);
    const parser = (collector as unknown as { parser: { parseURL: jest.Mock } })
      .parser;
    parser.parseURL = jest.fn().mockResolvedValue({ items: [feedItem] });
    const items = await collector.fetch(source(true), {
      since: new Date("2026-08-01T00:00:00Z"),
      perSourceLimit: 1,
      userId: "user-1",
    });
    expect(items[0]?.content).toBe("RSS description");
    expect(items[0]?.raw).toMatchObject({
      evidence: {
        transcript: { status: "rejected", reason: "too_short:5<200" },
      },
    });
  });
});
