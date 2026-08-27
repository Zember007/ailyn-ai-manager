import { Injectable } from "@nestjs/common";
import { loadAppConfig } from "@ailyn/config";

@Injectable()
export class WazzupClient {
  private readonly config = loadAppConfig();

  isConfigured(): boolean {
    return Boolean(this.config.wazzupApiKey && this.config.wazzupBaseUrl && this.config.wazzupChannelId);
  }
}
