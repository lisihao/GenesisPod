-- Native GenesisPod Radar source adapters. These enum values are consumed by
-- CollectorRouter; no solar-harness service or datastore is involved.
ALTER TYPE "RadarSourceType" ADD VALUE IF NOT EXISTS 'GITHUB';
ALTER TYPE "RadarSourceType" ADD VALUE IF NOT EXISTS 'HUGGING_FACE';
