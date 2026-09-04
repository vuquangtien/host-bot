import { ChannelType, Client } from 'discord.js';
import { config } from '../config/env';
import { buildCTFMilestones } from '../utils/ctf-schedule';
import databaseService from './database.service';
import challengeService from './challenge.service';
import challengeSyncService from './challenge-sync.service';
import discordService from './discord.service';
import logger from '../utils/logger';

const TICK_INTERVAL_MS = 60 * 1000;

class CTFSchedulerService {
  private running = false;
  private interval: NodeJS.Timeout | null = null;

  start(client: Client): void {
    if (this.interval) return;
    void this.tick(client);
    this.interval = setInterval(() => void this.tick(client), TICK_INTERVAL_MS);
  }

  stop(): void {
    if (!this.interval) return;
    clearInterval(this.interval);
    this.interval = null;
  }

  async tick(client: Client): Promise<void> {
    if (this.running) return;
    this.running = true;

    try {
      const guild = await client.guilds.fetch(config.SERVER_ID);
      const now = Math.floor(Date.now() / 1000);
      const ctfs = await databaseService.getAllCTFs();

      for (const ctf of ctfs) {
        if (ctf.data.archived || ctf.data.channelsPurged) continue;

        const category =
          guild.channels.cache.get(ctf.data.cate) ??
          (await guild.channels.fetch(ctf.data.cate).catch(() => null));
        if (category?.type !== ChannelType.GuildCategory) continue;

        const start = ctf.data.starttime ?? 0;
        const end = ctf.data.competitionEndtime || ctf.data.endtime;
        const milestones = buildCTFMilestones(start, end, ctf.data.name);
        if (milestones.length === 0) continue;

        for (const milestone of milestones) {
          if (now < milestone.startsAt || now >= milestone.expiresAt) continue;

          const reserved = await databaseService.markReminderSent(Number(ctf.key), milestone.key);
          if (!reserved) continue;

          try {
            await challengeService.announce(guild, ctf.data, milestone.text);
          } catch (error) {
            await databaseService.removeReminder(Number(ctf.key), milestone.key);
            logger.warn(
              `Reminder ${milestone.key} failed for ${ctf.data.name}; it will be retried:`,
              error
            );
          }
        }

        if (now >= start - 86400 && now <= end) {
          await challengeService
            .refreshDashboard(guild, ctf.key, ctf.data)
            .catch((error) => logger.warn(`Dashboard refresh failed for ${ctf.data.name}:`, error));
        }

        if (now >= start && now <= end) {
          const source = await databaseService.getChallengeSyncSource(Number(ctf.key));
          if (source?.enabled) {
            try {
              const summary = await challengeSyncService.syncCTF(guild, ctf.key, ctf.data, source);
              await databaseService.markChallengeSyncResult(Number(ctf.key), {
                ok: true,
                syncedAt: now,
              });
              if (summary.created > 0 || summary.adopted > 0) {
                logger.info(
                  `Synced ${ctf.data.name}: fetched=${summary.fetched}, ` +
                    `created=${summary.created}, adopted=${summary.adopted}, ` +
                    `provider=${summary.provider}`
                );
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              await databaseService.markChallengeSyncResult(Number(ctf.key), {
                ok: false,
                error: message,
              });
              logger.warn(`Challenge sync failed for ${ctf.data.name}:`, error);
            }
          }
        }
      }

      await discordService.syncEndedCTFs(guild);

      for (const ctf of ctfs) {
        if (
          ctf.data.archived ||
          ctf.data.channelsPurged ||
          ctf.data.endtime <= 0 ||
          now < ctf.data.endtime
        ) {
          continue;
        }

        const archived = await discordService.archiveCTFRecord(guild, ctf.key, ctf.data);
        if (!archived) {
          logger.warn(`Automatic archive failed for ${ctf.data.name}; it will be retried`);
        }
      }
    } catch (error) {
      logger.error('CTF scheduler failed:', error);
    } finally {
      this.running = false;
    }
  }
}

export default new CTFSchedulerService();
