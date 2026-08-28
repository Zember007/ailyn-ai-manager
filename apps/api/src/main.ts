import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { RequestLoggingInterceptor } from "./logs/request-logging.interceptor.js";
import { BackendLogsService } from "./logs/backend-logs.service.js";
import { AppModule } from "./app.module.js";
import { loadAppConfig } from "@ailyn/config";
import { PrismaExceptionFilter } from "./database/prisma-exception.filter.js";

async function bootstrap(): Promise<void> {
  const config = loadAppConfig();
  const app = await NestFactory.create(AppModule, { cors: true });
  const logs = app.get(BackendLogsService);
  app.setGlobalPrefix("api");
  app.useGlobalFilters(new PrismaExceptionFilter());
  app.useGlobalInterceptors(new RequestLoggingInterceptor(logs));
  await app.listen(config.apiPort, "0.0.0.0");
  await logs.log("bootstrap", `API started on port ${config.apiPort}`, {
    metadata: {
      aiProvider: config.aiProvider,
      whatsappProvider: config.whatsappProvider,
      nodeEnv: config.nodeEnv
    }
  });
}

void bootstrap();
