import { PlatformConfig, PlatformMatterbridge } from 'matterbridge';
import { AnsiLogger } from 'matterbridge/logger';

import { TTLockPlatform } from './platform.js';

export { TTLockPlatform } from './platform.js';

/**
 * Entry point called by Matterbridge to create the plugin platform.
 */
export default function initializePlugin(matterbridge: PlatformMatterbridge, log: AnsiLogger, config: PlatformConfig): TTLockPlatform {
  return new TTLockPlatform(matterbridge, log, config);
}
