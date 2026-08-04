-- The list of queue names exists twice: `queueDefinitions` in the domain
-- package, which application code validates against, and this constraint, which
-- the database enforces. `instagram.media.import` was added to the first and
-- never to the second, so every import request passed its in-process guard and
-- then failed the insert. The enqueue reports that as a generic dependency
-- failure, which is why the screen said the video could not be requested and no
-- audit row was ever written.
--
-- Both tables carry the list because both are written in the same transaction.
-- Extending one alone would move the failure by a statement rather than remove
-- it.
ALTER TABLE "background_jobs" DROP CONSTRAINT "background_jobs_queue_name_check";

ALTER TABLE "background_jobs"
ADD CONSTRAINT "background_jobs_queue_name_check" CHECK ("queue_name" IN (
  'instagram.sync.account',
  'instagram.snapshot.post',
  'instagram.token.maintain',
  'instagram.media.import',
  'asset.validate',
  'asset.cleanup',
  'analysis.run',
  'analytics.recalculate',
  'strategy.generate',
  'system.reconcile'
));

ALTER TABLE "job_outbox" DROP CONSTRAINT "job_outbox_queue_name_check";

ALTER TABLE "job_outbox"
ADD CONSTRAINT "job_outbox_queue_name_check" CHECK ("queue_name" IN (
  'instagram.sync.account',
  'instagram.snapshot.post',
  'instagram.token.maintain',
  'instagram.media.import',
  'asset.validate',
  'asset.cleanup',
  'analysis.run',
  'analytics.recalculate',
  'strategy.generate',
  'system.reconcile'
));
