import type { AccountProviderHooks } from '../core/providers/registry';
import { ProviderService as CoreProviderService } from '../core/providers/service';
import type { ConfigService } from './config';
import type { Logger } from './logger';
import { SecretsService } from './secrets';

/**
 * ProviderService của VS Code: nối lõi dùng chung với ConfigService, SecretStorage và Logger.
 * `account`: token tài khoản Locaith + tiêu đề + chốt chặn đồng ý cho nhà cung cấp `locaith` (họ AI Local) — có thì nhà cung cấp đó được đăng ký.
 */
export class ProviderService extends CoreProviderService {
  constructor(config: ConfigService, secrets: SecretsService, logger: Logger, account?: AccountProviderHooks) {
    super({
      baseUrls: () => config.baseUrls(),
      customProviders: () => config.customProviders(),
      eagerInput: () => config.eagerInput(),
      summarizerModel: () => config.summarizerModel(),
      resolveKey: (id) => secrets.get(SecretsService.provider(id)),
      log: (level, msg) => logger.log(level, msg),
      account,
    });
  }
}
